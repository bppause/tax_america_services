#!/usr/bin/env node
'use strict';

// fix-task-titles.js
//
// One-time migration that corrects two classes of bad task titles created
// before the June 2026 fix:
//
//   1. LANGUAGE — tasks were titled in the customer's locale (often Spanish)
//      even though tasks are employee-facing. All titles are normalized to
//      English: schedule/auto-task names come from their DB name_i18n.en,
//      and period labels ("Año Fiscal 2026" → "Tax Year 2026", etc.) are
//      translated via a pattern map.
//
//   2. YEAR — H1 bookkeeping tasks were labelled "Tax Year N-1" because the
//      annual() schedule function always decrements the due year by 1. H1 is
//      due Jul 31 of the year it covers, so the label should use the due year
//      itself (taxYearOffset: 0). The task's period_key is also updated so
//      the idempotency index stays consistent with the new logic.
//
// Usage:
//   node scripts/fix-task-titles.js --dry-run   # preview changes, no writes
//   node scripts/fix-task-titles.js             # apply changes

try { require('dotenv').config(); } catch (_) {}

const { createClient } = require('@supabase/supabase-js');

const DRY_RUN = process.argv.includes('--dry-run');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Period-label translation (ES → EN) ──────────────────────────────────────

const ES_MONTHS = [
  'enero','febrero','marzo','abril','mayo','junio',
  'julio','agosto','septiembre','octubre','noviembre','diciembre',
];
const EN_MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

function translatePeriodLabel(label) {
  if (!label) return label;

  // "Año Fiscal YYYY" → "Tax Year YYYY"
  let m = /^Año Fiscal (\d{4})$/.exec(label);
  if (m) return `Tax Year ${m[1]}`;

  // "T1 YYYY" → "Q1 YYYY" (trimestral → quarterly)
  m = /^T(\d) (\d{4})$/.exec(label);
  if (m) return `Q${m[1]} ${m[2]}`;

  // "Enero 2026" → "January 2026" (monthly)
  for (let i = 0; i < 12; i++) {
    const cap = ES_MONTHS[i][0].toUpperCase() + ES_MONTHS[i].slice(1);
    if (label.startsWith(cap + ' ')) return EN_MONTHS[i] + label.slice(cap.length);
  }

  // "Semana del YYYY-MM-DD" → "Week of YYYY-MM-DD"
  m = /^Semana del (.+)$/.exec(label);
  if (m) return `Week of ${m[1]}`;

  return label; // already English or unrecognised
}

// H1 tasks have due dates in July. Before the taxYearOffset fix the label
// said "Tax Year N-1" instead of "Tax Year N". Detect and fix that.
function fixH1Year(title, dueDateIso) {
  if (!/\bH1\b/i.test(title)) return title;
  const dueYear = new Date(dueDateIso + 'T00:00:00Z').getUTCFullYear();
  return title.replace(/Tax Year (\d{4})/, (full, y) => {
    const labelYear = parseInt(y, 10);
    return labelYear === dueYear - 1 ? `Tax Year ${dueYear}` : full;
  });
}

// H1 period_key was built with periodStart = taxYear-1 (e.g. "2025-01-01"
// for a July-2026 due date). Update it to the correct year.
function fixH1PeriodKey(periodKey, dueDateIso, title) {
  if (!periodKey || !/\bH1\b/i.test(title)) return periodKey;
  const dueYear = new Date(dueDateIso + 'T00:00:00Z').getUTCFullYear();
  const wrong = `${dueYear - 1}-01-01`;
  const right  = `${dueYear}-01-01`;
  if (periodKey.includes(wrong)) return periodKey.replace(wrong, right);
  return periodKey;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN — no writes ===' : '=== LIVE RUN ===');
  console.log();

  // ── Load tasks ────────────────────────────────────────────────────────────
  const { data: tasks, error: tasksErr } = await supabase
    .from('tax_tasks')
    .select('id, title, due_date, period_key, schedule_id, service_auto_task_id, product_id')
    .eq('source', 'relationship_schedule')
    .is('archived_at', null)
    .order('due_date', { ascending: true });

  if (tasksErr) { console.error('Failed to load tasks:', tasksErr.message); process.exit(1); }
  console.log(`Loaded ${tasks.length} active relationship_schedule tasks.\n`);

  // ── Load name sources ────────────────────────────────────────────────────
  // 1. tax_service_auto_tasks (auto_task path — H1/H2 bookkeeping, etc.)
  const atIds = [...new Set(tasks.map(t => t.service_auto_task_id).filter(Boolean))];
  const atMap = {};
  if (atIds.length) {
    const { data: ats } = await supabase
      .from('tax_service_auto_tasks')
      .select('id, title_i18n')
      .in('id', atIds);
    (ats || []).forEach(a => { atMap[a.id] = a; });
  }

  // 2. tax_filing_schedules (workflow_rule / legacy path)
  const schedIds = [...new Set(tasks.map(t => t.schedule_id).filter(Boolean))];
  const schedMap = {};
  if (schedIds.length) {
    const { data: scheds } = await supabase
      .from('tax_filing_schedules')
      .select('id, name_i18n')
      .in('id', schedIds);
    (scheds || []).forEach(s => { schedMap[s.id] = s; });
  }

  // 3. tax_products (product_cadence legacy path — product_id set, neither above)
  const prodIds = [...new Set(
    tasks
      .filter(t => !t.schedule_id && !t.service_auto_task_id && t.product_id)
      .map(t => t.product_id),
  )];
  const prodMap = {};
  if (prodIds.length) {
    const { data: prods } = await supabase
      .from('tax_products')
      .select('id, name_i18n')
      .in('id', prodIds);
    (prods || []).forEach(p => { prodMap[p.id] = p; });
  }

  // ── Compute corrections ───────────────────────────────────────────────────
  const SEP = ' — ';
  const updates = [];
  let skipped = 0;

  for (const task of tasks) {
    // Split "Schedule Name — Period Label" on the first " — "
    const sepIdx = task.title.indexOf(SEP);
    const rawName   = sepIdx >= 0 ? task.title.slice(0, sepIdx) : task.title;
    const rawPeriod = sepIdx >= 0 ? task.title.slice(sepIdx + SEP.length) : '';

    // Resolve English name
    let enName = rawName;
    if (task.service_auto_task_id && atMap[task.service_auto_task_id]) {
      const at = atMap[task.service_auto_task_id];
      enName = at.title_i18n?.en || at.title_i18n?.es || rawName;
    } else if (task.schedule_id && schedMap[task.schedule_id]) {
      const s = schedMap[task.schedule_id];
      enName = s.name_i18n?.en || s.name_i18n?.es || rawName;
    } else if (task.product_id && prodMap[task.product_id]) {
      const p = prodMap[task.product_id];
      enName = p.name_i18n?.en || p.name_i18n?.es || rawName;
    }

    const enPeriod = translatePeriodLabel(rawPeriod);
    let newTitle = rawPeriod ? `${enName}${SEP}${enPeriod}` : enName;
    newTitle = fixH1Year(newTitle, task.due_date);

    const newPeriodKey = fixH1PeriodKey(task.period_key, task.due_date, newTitle);

    if (newTitle === task.title && newPeriodKey === task.period_key) {
      skipped++;
      continue;
    }

    updates.push({ id: task.id, due_date: task.due_date, newTitle, newPeriodKey,
                   oldTitle: task.title, oldPeriodKey: task.period_key });
  }

  console.log(`Already correct: ${skipped}`);
  console.log(`Need updating:   ${updates.length}\n`);

  if (!updates.length) {
    console.log('Nothing to do.');
    return;
  }

  // Print diff
  for (const u of updates) {
    console.log(`[${u.id}]  due: ${u.due_date}`);
    if (u.newTitle !== u.oldTitle) {
      console.log(`  title:      "${u.oldTitle}"`);
      console.log(`           →  "${u.newTitle}"`);
    }
    if (u.newPeriodKey !== u.oldPeriodKey) {
      console.log(`  period_key: "${u.oldPeriodKey}"`);
      console.log(`           →  "${u.newPeriodKey}"`);
    }
    console.log();
  }

  if (DRY_RUN) {
    console.log('DRY RUN complete — re-run without --dry-run to apply.');
    return;
  }

  // ── Apply ────────────────────────────────────────────────────────────────
  let ok = 0, fail = 0;
  const conflicts = [];

  for (const u of updates) {
    const { error: uerr } = await supabase
      .from('tax_tasks')
      .update({ title: u.newTitle, period_key: u.newPeriodKey })
      .eq('id', u.id);

    if (uerr) {
      // A unique-constraint violation on period_key means a duplicate task
      // (with the correct year/key) was already created after the code fix.
      // The old task should be deleted manually.
      if (uerr.code === '23505') {
        conflicts.push(u);
        console.warn(`  CONFLICT ${u.id}: period_key "${u.newPeriodKey}" already exists.`);
        console.warn(`  → Delete task ${u.id} (the stale duplicate) from the DB, then the correct task remains.`);
      } else {
        console.error(`  FAILED ${u.id}: ${uerr.message}`);
      }
      fail++;
    } else {
      ok++;
    }
  }

  console.log(`\nDone.  Updated: ${ok}  Conflicts/failed: ${fail}`);

  if (conflicts.length) {
    console.log('\nTasks with period_key conflicts (stale duplicates to delete):');
    conflicts.forEach(u => console.log(`  ${u.id}  "${u.oldTitle}"`));
  }
}

main().catch(e => { console.error(e); process.exit(1); });

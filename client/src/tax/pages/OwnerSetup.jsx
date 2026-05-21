import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { useEmployeeAuth } from '../auth/EmployeeAuthProvider';
import { taxApi } from '../api';
import EmployeeShell from '../components/EmployeeShell';

// Phase 4m: first-run setup checklist. Status is computed server-side
// from existing tables — no schema changes. Each step links into its
// existing config page. The banner on the inbox dismisses itself once
// everything is complete (or the owner clicks Dismiss).
//
// Required steps gate the badge "Practice is ready". Optional steps
// show a quieter badge and don't gate readiness.
const STEP_LINKS = {
  brand:     'settings',
  services:  'services',
  workflows: 'workflows',
  emails:    'email-templates',
  staff:     'staff',
  customers: 'customers',
};

export default function OwnerSetup() {
  const { t } = useT();
  const { fbUser, employee, community } = useEmployeeAuth();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };

  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  const load = () => {
    if (!employee || !community) return;
    setErr('');
    taxApi.adminGetSetupStatus(auth, community.id)
      .then(d => setData(d))
      .catch(e => setErr(e?.message || t('error.loadFailed')));
  };
  useEffect(load, [fbUser, community]); // eslint-disable-line react-hooks/exhaustive-deps

  if (employee && employee.role !== 'admin') {
    return <EmployeeShell community={community} active="setup">
      <div className="tax-msg tax-msg--error">{t('owner.notAuthorized')}</div>
    </EmployeeShell>;
  }

  const base = community ? `/tax/${community.id}/employee` : '#';
  const steps = data?.steps || [];
  const requiredSteps = steps.filter(s => !s.optional);
  const allRequiredDone = requiredSteps.every(s => s.done);
  const totalDone = steps.filter(s => s.done).length;

  return (
    <EmployeeShell community={community} active="setup">
      <h2 style={{ marginTop: 0 }}>{t('owner.setup.title')}</h2>
      <p className="tax-section__lede">{t('owner.setup.subtitle')}</p>

      {err && <div className="tax-msg tax-msg--error">{err}</div>}
      {!data && !err && <p>{t('loading')}</p>}

      {data && (
        <>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            background: allRequiredDone
              ? 'color-mix(in srgb, var(--tax-success) 8%, #fff)'
              : 'var(--tax-bg-alt)',
            border: `1px solid ${allRequiredDone ? 'var(--tax-success)' : 'var(--tax-border)'}`,
            color: allRequiredDone ? 'var(--tax-success)' : 'var(--tax-text)',
            padding: '14px 18px', borderRadius: 10, marginBottom: 20, gap: 12, flexWrap: 'wrap',
          }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>
                {allRequiredDone ? t('owner.setup.readyTitle') : t('owner.setup.progressTitle')}
              </div>
              <div style={{ fontSize: 13, marginTop: 2 }}>
                {t('owner.setup.progress', { done: totalDone, total: steps.length })}
              </div>
            </div>
            {allRequiredDone && (
              <span style={{
                padding: '4px 12px', borderRadius: 999, fontSize: 12, fontWeight: 700,
                background: 'var(--tax-success)', color: '#fff',
              }}>
                {t('owner.setup.readyBadge')}
              </span>
            )}
          </div>

          <div style={{ display: 'grid', gap: 10 }}>
            {steps.map((step, idx) => {
              const href = `${base}/${STEP_LINKS[step.key] || ''}`;
              return (
                <div key={step.key} style={{
                  display: 'flex', alignItems: 'center', gap: 16,
                  padding: 14, border: '1px solid var(--tax-border)', borderRadius: 10,
                  background: step.done ? 'color-mix(in srgb, var(--tax-success) 5%, #fff)' : '#fff',
                }}>
                  <div style={{
                    width: 32, height: 32, borderRadius: '50%',
                    background: step.done ? 'var(--tax-success)' : 'var(--tax-bg-alt)',
                    color: step.done ? '#fff' : 'var(--tax-muted)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontWeight: 700, fontSize: 14, flexShrink: 0,
                  }}>
                    {step.done ? '✓' : (idx + 1)}
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 15 }}>{t(`owner.setup.step.${step.key}.title`)}</strong>
                      {step.optional && (
                        <span style={{
                          padding: '1px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
                          background: 'var(--tax-bg-alt)', color: 'var(--tax-muted)',
                        }}>
                          {t('owner.setup.optionalBadge')}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--tax-muted)', marginTop: 2 }}>
                      {t(`owner.setup.step.${step.key}.description`)}
                    </div>
                    {step.summary && (
                      <div style={{ fontSize: 12, color: 'var(--tax-muted)', marginTop: 4, fontFamily: 'monospace' }}>
                        {step.summary}
                      </div>
                    )}
                  </div>
                  <a href={href} className="tax-btn tax-btn--sm"
                     style={{
                       background: step.done ? 'transparent' : 'var(--tax-brand-primary)',
                       color: step.done ? 'var(--tax-brand-primary)' : '#fff',
                       border: step.done ? '1px solid var(--tax-brand-primary)' : 'none',
                       flexShrink: 0,
                     }}>
                    {step.done ? t('owner.setup.review') : t('owner.setup.configure')}
                  </a>
                </div>
              );
            })}
          </div>
        </>
      )}
    </EmployeeShell>
  );
}

import { useEffect, useState } from 'react';
import { pickI18n, useT } from '../i18n';
import { taxApi } from '../api';

// Multi-step lead intake wizard. Same submitLead payload as the
// single-page LeadForm, but split into four focused steps so the
// visitor commits incrementally and abandonment drops:
//   1. Filer type     — individual vs. business
//   2. Services       — chip multi-select (required: at least one)
//   3. Contact info   — names + email + phone (+ company if business),
//                       optional WhatsApp
//   4. Message + send — optional free-text + locale carryover + submit
//
// Each Next press validates the current step; Back is always allowed
// so the visitor can correct upstream answers without losing data.
// initialProductSlug pre-selects the service chip when the visitor
// reached this from a service card.
const STEPS = ['type', 'services', 'contact', 'message'];

export default function LeadWizard({ community, products, initialProductSlug }) {
  const { locale, t } = useT();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({
    customerType: 'individual',
    firstName: '', middleName: '', lastName: '',
    email: '', phone: '', whatsapp: '', company: '',
    productSlugs: [], message: '', website: '',
  });
  const [status, setStatus] = useState({ kind: 'idle', message: '' });
  const [errs, setErrs] = useState({});

  useEffect(() => {
    if (!initialProductSlug) return;
    setForm(f => f.productSlugs.includes(initialProductSlug)
      ? f : { ...f, productSlugs: [...f.productSlugs, initialProductSlug] });
  }, [initialProductSlug]);

  const visibleProducts = (products || []).filter(p => p.enabled !== false);
  const onChange = (k, v) => {
    setForm(f => ({ ...f, [k]: v }));
    if (errs[k]) setErrs(e => ({ ...e, [k]: '' }));
  };
  const toggleService = (slug) => {
    setForm(f => ({
      ...f,
      productSlugs: f.productSlugs.includes(slug)
        ? f.productSlugs.filter(s => s !== slug)
        : [...f.productSlugs, slug],
    }));
    if (errs.productSlugs) setErrs(e => ({ ...e, productSlugs: '' }));
  };

  // Per-step validation. Each step's check returns an errors object
  // (empty = pass). Centralizing this keeps the Next button single-
  // sourced and lets us highlight specific fields in red.
  const validate = (s) => {
    const e = {};
    if (s === 0) {
      if (!['individual','business'].includes(form.customerType)) e.customerType = 'required';
    }
    if (s === 1) {
      if (form.productSlugs.length === 0) e.productSlugs = t('lead.error.serviceRequired');
    }
    if (s === 2) {
      if (!form.firstName.trim()) e.firstName = t('lead.error.firstNameRequired');
      if (!form.lastName.trim())  e.lastName  = t('lead.error.lastNameRequired');
      if (!form.email.trim() || !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(form.email)) e.email = t('lead.error.emailInvalid');
      if (!form.phone.trim()) e.phone = t('lead.error.phoneRequired');
      if (form.customerType === 'business' && !form.company.trim()) e.company = t('lead.error.companyRequired');
    }
    return e;
  };

  const goNext = () => {
    const e = validate(step);
    setErrs(e);
    if (Object.keys(e).length) return;
    setStep(s => Math.min(STEPS.length - 1, s + 1));
  };
  const goBack = () => setStep(s => Math.max(0, s - 1));

  const onSubmit = async (e) => {
    e?.preventDefault?.();
    if (status.kind === 'submitting') return;
    // Re-run every prior validation in case the visitor edited an
    // upstream field after stepping past it.
    const merged = { ...validate(0), ...validate(1), ...validate(2) };
    if (Object.keys(merged).length) {
      setErrs(merged);
      // Jump back to the first failing step so the visitor sees the
      // error in context instead of just a toast.
      const firstFail = [0,1,2].find(s => Object.keys(validate(s)).length);
      if (firstFail !== undefined) setStep(firstFail);
      return;
    }
    setStatus({ kind: 'submitting', message: '' });
    try {
      await taxApi.submitLead({
        communitySlug: community.id,
        customerType: form.customerType,
        firstName: form.firstName,
        middleName: form.middleName,
        lastName: form.lastName,
        email: form.email,
        phone: form.phone,
        whatsapp: form.whatsapp,
        company: form.customerType === 'business' ? form.company : '',
        productSlugs: form.productSlugs,
        message: form.message,
        locale,
        website: form.website,
      });
      setStatus({ kind: 'success', message: '' });
    } catch (err) {
      const isNetwork = !err?.status;
      setStatus({
        kind: 'error',
        message: isNetwork ? t('lead.error.network') : (err.message || t('lead.error.generic')),
      });
    }
  };

  if (status.kind === 'success') {
    return (
      <div className="tax-form" role="status">
        <div className="tax-msg tax-msg--success">
          <strong>{t('lead.success.heading')}</strong>
          <div style={{ marginTop: 6 }}>{t('lead.success.body')}</div>
        </div>
      </div>
    );
  }

  return (
    <form className="tax-form" onSubmit={onSubmit} noValidate>
      <ProgressBar step={step} total={STEPS.length} t={t} />

      {step === 0 && (
        <StepType form={form} onChange={onChange} t={t} />
      )}
      {step === 1 && (
        <StepServices form={form} products={visibleProducts}
                      toggleService={toggleService}
                      err={errs.productSlugs} locale={locale} t={t} />
      )}
      {step === 2 && (
        <StepContact form={form} onChange={onChange} errs={errs} t={t} />
      )}
      {step === 3 && (
        <StepMessage form={form} onChange={onChange} t={t} />
      )}

      {/* Honeypot field — kept across all steps so a bot script that
          fills every input still trips. Real users never see it. */}
      <input type="text" name="website" tabIndex={-1} autoComplete="off"
             value={form.website} onChange={e => onChange('website', e.target.value)}
             style={{ position: 'absolute', left: '-9999px', height: 0, width: 0 }} />

      {status.kind === 'error' && (
        <div className="tax-msg tax-msg--error" style={{ marginTop: 12 }}>
          {status.message}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 16 }}>
        <button type="button" onClick={goBack}
                disabled={step === 0 || status.kind === 'submitting'}
                className="tax-btn tax-btn--ghost"
                style={{ visibility: step === 0 ? 'hidden' : 'visible', color: 'var(--tax-text)' }}>
          ← {t('lead.wizard.back')}
        </button>
        {step < STEPS.length - 1 ? (
          <button type="button" onClick={goNext} className="tax-btn tax-btn--primary">
            {t('lead.wizard.next')} →
          </button>
        ) : (
          <button type="submit" className="tax-btn tax-btn--primary"
                  disabled={status.kind === 'submitting'}>
            {status.kind === 'submitting' ? t('lead.submitting') : t('lead.wizard.submit')}
          </button>
        )}
      </div>
    </form>
  );
}

function ProgressBar({ step, total, t }) {
  const pct = ((step + 1) / total) * 100;
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between',
                     fontSize: 12, color: 'var(--tax-muted)', marginBottom: 6 }}>
        <span>{t('lead.wizard.stepOf', { n: step + 1, total })}</span>
        <span>{t(`lead.wizard.step.${STEPS[step]}.label`)}</span>
      </div>
      <div style={{ height: 6, background: 'var(--tax-bg-alt)', borderRadius: 999, overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: `${pct}%`,
          background: 'var(--tax-brand-primary)',
          transition: 'width .2s ease',
        }} />
      </div>
    </div>
  );
}

function StepType({ form, onChange, t }) {
  return (
    <div>
      <h3 style={{ margin: '0 0 4px' }}>{t('lead.wizard.step.type.title')}</h3>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--tax-muted)' }}>
        {t('lead.wizard.step.type.lede')}
      </p>
      <div role="radiogroup" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {['individual','business'].map(opt => {
          const active = form.customerType === opt;
          return (
            <button key={opt} type="button" role="radio" aria-checked={active}
                    onClick={() => onChange('customerType', opt)}
                    style={{
                      padding: 16, borderRadius: 10, cursor: 'pointer',
                      border: `2px solid ${active ? 'var(--tax-brand-primary)' : 'var(--tax-border)'}`,
                      background: active ? 'color-mix(in srgb, var(--tax-brand-primary) 8%, #fff)' : '#fff',
                      fontWeight: active ? 700 : 500, fontSize: 15, textAlign: 'left',
                    }}>
              <div style={{ fontSize: 22, marginBottom: 4 }}>
                {opt === 'individual' ? '👤' : '🏢'}
              </div>
              {t(`lead.field.customerType.${opt}`)}
              <div style={{ fontSize: 12, color: 'var(--tax-muted)', fontWeight: 400, marginTop: 4 }}>
                {t(`lead.wizard.step.type.${opt}.hint`)}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StepServices({ form, products, toggleService, err, locale, t }) {
  return (
    <div>
      <h3 style={{ margin: '0 0 4px' }}>{t('lead.wizard.step.services.title')}</h3>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--tax-muted)' }}>
        {t('lead.wizard.step.services.lede')}
      </p>
      {err && (
        <div className="tax-msg tax-msg--error" style={{ marginBottom: 10 }}>{err}</div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {products.map(p => {
          const active = form.productSlugs.includes(p.slug);
          return (
            <button key={p.id} type="button" onClick={() => toggleService(p.slug)}
                    style={{
                      padding: '8px 14px', borderRadius: 999, fontWeight: 600,
                      border: `1px solid ${active ? 'var(--tax-brand-primary)' : 'var(--tax-border)'}`,
                      background: active
                        ? 'color-mix(in srgb, var(--tax-brand-primary) 12%, #fff)'
                        : '#fff',
                      color: active ? 'var(--tax-brand-primary)' : 'var(--tax-text)',
                      cursor: 'pointer', fontSize: 13,
                    }}>
              {active ? '✓ ' : ''}{pickI18n(p.name_i18n, locale).value || p.slug}
            </button>
          );
        })}
      </div>
      <p style={{ marginTop: 12, fontSize: 12, color: 'var(--tax-muted)' }}>
        {t('lead.wizard.step.services.foot', { n: form.productSlugs.length })}
      </p>
    </div>
  );
}

function StepContact({ form, onChange, errs, t }) {
  return (
    <div>
      <h3 style={{ margin: '0 0 4px' }}>{t('lead.wizard.step.contact.title')}</h3>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--tax-muted)' }}>
        {t('lead.wizard.step.contact.lede')}
      </p>
      <div className="tax-form__row3" style={{ marginBottom: 10 }}>
        <Field name="firstName" label={t('lead.field.firstName')} required
               value={form.firstName} onChange={onChange} err={errs.firstName} />
        <Field name="middleName" label={t('lead.field.middleName')}
               value={form.middleName} onChange={onChange} />
        <Field name="lastName" label={t('lead.field.lastName')} required
               value={form.lastName} onChange={onChange} err={errs.lastName} />
      </div>
      {form.customerType === 'business' && (
        <Field name="company" label={t('lead.field.company')} required
               value={form.company} onChange={onChange} err={errs.company} />
      )}
      <div className="tax-form__row2" style={{ marginTop: 10 }}>
        <Field name="email" type="email" label={t('lead.field.email')} required
               value={form.email} onChange={onChange} err={errs.email} />
        <Field name="phone" type="tel" label={t('lead.field.phone')} required
               value={form.phone} onChange={onChange} err={errs.phone} />
      </div>
      <Field name="whatsapp" type="tel" label={t('lead.field.whatsapp')}
             hint={t('lead.field.whatsappHint')}
             value={form.whatsapp} onChange={onChange} />
    </div>
  );
}

function StepMessage({ form, onChange, t }) {
  return (
    <div>
      <h3 style={{ margin: '0 0 4px' }}>{t('lead.wizard.step.message.title')}</h3>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--tax-muted)' }}>
        {t('lead.wizard.step.message.lede')}
      </p>
      <label style={{ fontSize: 13, fontWeight: 600 }}>{t('lead.field.message')}</label>
      <textarea rows={5} value={form.message} maxLength={2000}
                onChange={e => onChange('message', e.target.value)}
                placeholder={t('lead.wizard.step.message.placeholder')}
                style={{ width: '100%', padding: 10, border: '1px solid var(--tax-border)', borderRadius: 6, fontFamily: 'inherit', fontSize: 14, marginTop: 4 }} />
      <div style={{ marginTop: 12, padding: 10, borderRadius: 8,
                     background: 'var(--tax-bg-alt)', fontSize: 13 }}>
        <strong>{t('lead.wizard.step.message.recapHeading')}</strong>
        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          <li>{t(`lead.field.customerType.${form.customerType}`)}{form.customerType === 'business' && form.company ? ` — ${form.company}` : ''}</li>
          <li>{form.firstName} {form.middleName} {form.lastName} · {form.email}</li>
          <li>{t('lead.wizard.step.message.recapServices', { n: form.productSlugs.length })}</li>
        </ul>
      </div>
    </div>
  );
}

function Field({ name, label, type = 'text', value, onChange, required, err, hint }) {
  return (
    <div>
      <label style={{ fontSize: 13, fontWeight: 600 }}>
        {label}{required ? ' *' : ''}
      </label>
      <input type={type} value={value} onChange={e => onChange(name, e.target.value)}
             maxLength={200}
             style={{
               width: '100%', padding: 10, marginTop: 4, fontSize: 14,
               border: `1px solid ${err ? 'var(--tax-error)' : 'var(--tax-border)'}`,
               borderRadius: 6,
             }} />
      {err && <div style={{ color: 'var(--tax-error)', fontSize: 12, marginTop: 4 }}>{err}</div>}
      {hint && !err && <div style={{ color: 'var(--tax-muted)', fontSize: 12, marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

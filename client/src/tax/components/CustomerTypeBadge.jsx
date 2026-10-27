// Small, consistent "Business" / "Individual" indicator shown next to a
// customer's name wherever the list is long enough that staff can't tell
// from the name alone (a person's name doesn't say whether they're
// actually an LLC/corp client vs. a filing-for-themselves individual).
// Always renders — unlike the old business-only pill, an unlabeled row
// used to read as "didn't load" as often as "individual".
export default function CustomerTypeBadge({ type, t, style }) {
  const isBusiness = type === 'business';
  return (
    <span style={{
      marginLeft: 8, padding: '1px 8px', borderRadius: 999,
      display: 'inline-flex', alignItems: 'center', gap: 4,
      background: isBusiness
        ? 'color-mix(in srgb, var(--tax-brand-primary) 12%, #fff)'
        : 'color-mix(in srgb, var(--tax-muted) 12%, #fff)',
      color: isBusiness ? 'var(--tax-brand-primary)' : 'var(--tax-muted)',
      border: `1px solid ${isBusiness
        ? 'color-mix(in srgb, var(--tax-brand-primary) 30%, #fff)'
        : 'color-mix(in srgb, var(--tax-muted) 30%, #fff)'}`,
      fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em',
      ...style,
    }}>
      <span aria-hidden="true">{isBusiness ? '🏢' : '👤'}</span>
      {t(isBusiness ? 'owner.customers.customerType.business' : 'owner.customers.customerType.individual')}
    </span>
  );
}

// Compact icon-only variant for tight spaces (task rows, group headers,
// dropdown option lists) where a full pill would be too wide.
export function customerTypeIcon(type) {
  return type === 'business' ? '🏢' : '👤';
}

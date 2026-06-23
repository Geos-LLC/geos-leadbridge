import BusinessHoursEditor from '../../components/BusinessHoursEditor';
import QuietHoursEditor from '../../components/QuietHoursEditor';

/**
 * Settings → Hours tab — the same canonical collapsible editor used in
 * the wizard renders both Business Hours and Quiet Hours here. Each
 * component owns its own hydration + 600ms debounced auto-save, so this
 * page is now a thin shell with no state of its own.
 */
export function SettingsHours() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <BusinessHoursEditor defaultOpen />
      <QuietHoursEditor defaultOpen />
    </div>
  );
}

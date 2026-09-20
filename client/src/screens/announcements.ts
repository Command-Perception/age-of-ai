import { el } from '../ui';
import { activeAnnouncements, announcementCategories, announcementPreferences as store, type AnnouncementCategory, type Frequency } from '../game/announcements';

/** Shares one store with voice tools; subscriptions are disposed when Options is rebuilt. */
export function announcementsPanel(): { panel: HTMLElement; dispose: () => void } {
  const panel = el('div', 'opt-tab-panel announcement-settings');
  panel.setAttribute('role', 'tabpanel');
  const active = el('div', 'announcement-active');
  const error = el('p', 'vowel-settings-status error');
  error.setAttribute('role', 'status');
  panel.append(el('h3', '', 'Active now'), active, el('p', 'opt-hint', 'Current conditions are informative, not a queue of things to say.'), error);
  const controls = new Map<AnnouncementCategory, { check: HTMLInputElement; number?: HTMLInputElement; frequency?: HTMLSelectElement }>();
  let group = '';
  for (const [category, [section, label]] of Object.entries(announcementCategories) as [AnnouncementCategory, readonly [string, string]][]) {
    // Strategy suggestions have their own dedicated tab and master toggle.
    if (category === 'strategySuggestion') continue;
    if (section !== group) { panel.append(el('h3', '', section)); group = section; }
    const row = el('label', 'opt-row');
    const check = el('input') as HTMLInputElement;
    check.type = 'checkbox';
    check.addEventListener('change', () => store.update(category, { enabled: check.checked }));
    row.append(check, el('span', 'opt-label', label));
    const entry: { check: HTMLInputElement; number?: HTMLInputElement; frequency?: HTMLSelectElement } = { check };
    if (category === 'idleVillagers' || category === 'population') {
      const input = el('input', 'txt') as HTMLInputElement;
      input.type = 'number'; input.min = '1'; input.max = '100'; input.step = '1'; input.style.width = '4.5rem';
      input.setAttribute('aria-label', category === 'idleVillagers' ? 'Minimum idle villagers' : 'Remaining population slots');
      input.addEventListener('change', () => {
        if (!input.reportValidity()) return;
        store.update(category, { [category === 'idleVillagers' ? 'threshold' : 'remainingSlotsThreshold']: Number(input.value) });
      });
      entry.number = input; row.append(input);
    }
    if (store.get()[category].frequency) {
      const select = el('select', 'txt') as HTMLSelectElement;
      select.setAttribute('aria-label', `${label} frequency`);
      for (const value of ['low', 'normal', 'high']) { const option = el('option', '', value); option.value = value; select.append(option); }
      select.addEventListener('change', () => store.update(category, { frequency: select.value as Frequency }));
      entry.frequency = select; row.append(select);
    }
    controls.set(category, entry); panel.append(row);
  }
  panel.append(el('h3', '', 'Mute'));
  const muteStatus = el('p', 'opt-hint');
  const muteButtons = el('div', 'vowel-settings-actions');
  for (const [label, minutes] of [['5 min', 5], ['15 min', 15], ['Until unmuted', -1], ['Unmute', 0]] as const) {
    const button = el('button', 'btn', label); button.type = 'button';
    button.addEventListener('click', () => store.mute(minutes < 0 ? 'forever' : minutes === 0 ? null : Date.now() + minutes * 60_000));
    muteButtons.append(button);
  }
  const urgentRow = el('label', 'opt-row');
  const urgent = el('input') as HTMLInputElement; urgent.type = 'checkbox';
  urgent.addEventListener('change', () => { const m = store.get().mute; store.mute(m.untilUnmuted ? 'forever' : (m.mutedUntil ?? 0) > Date.now() ? m.mutedUntil : null, urgent.checked); });
  urgentRow.append(urgent, el('span', 'opt-label', 'Allow urgent under-attack warnings during mute'));
  const reset = el('button', 'btn', 'Restore defaults'); reset.type = 'button'; reset.addEventListener('click', () => store.reset());
  panel.append(muteStatus, muteButtons, urgentRow, reset);
  const render = () => {
    const prefs = store.get(); error.textContent = store.error ?? ''; error.classList.toggle('hidden', !store.error);
    for (const [key, control] of controls) {
      control.check.checked = prefs[key].enabled;
      if (control.number) control.number.value = String(prefs[key].threshold ?? prefs[key].remainingSlotsThreshold);
      if (control.frequency) control.frequency.value = prefs[key].frequency ?? 'low';
    }
    active.replaceChildren();
    const current = activeAnnouncements.get().filter(condition => condition.category !== 'strategySuggestion');
    if (!current.length) active.append(el('p', 'opt-hint', 'No active conditions. Join a game to see live updates.'));
    for (const condition of current) active.append(el('p', '', `${condition.label}${condition.enabled ? '' : ' — disabled'}${condition.detail ? ` · ${condition.detail}` : ''}`));
    urgent.checked = prefs.mute.urgentOverrideEnabled;
    muteStatus.textContent = prefs.mute.untilUnmuted ? 'Muted until you unmute.' : (prefs.mute.mutedUntil ?? 0) > Date.now() ? `Muted until ${new Date(prefs.mute.mutedUntil!).toLocaleTimeString()}.` : 'Announcements are unmuted.';
  };
  const offPrefs = store.subscribe(render); const offActive = activeAnnouncements.subscribe(render);
  const timer = window.setInterval(render, 10_000);
  render();
  return { panel, dispose: () => { offPrefs(); offActive(); window.clearInterval(timer); } };
}

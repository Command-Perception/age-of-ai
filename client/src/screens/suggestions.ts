import { suggestionBiases, suggestionPreferences, type SuggestionBias } from '../game/suggestions';
import { el } from '../ui';

const labels: Record<SuggestionBias, { title: string; detail: string }> = {
  resources: { title: 'Resources', detail: 'Economy, villagers, gathering, and drop-off buildings.' },
  military: { title: 'Military', detail: 'Army production, defenses, and combat readiness.' },
  technology: { title: 'Technology', detail: 'Research, prerequisites, and age advancement.' },
  balanced: { title: 'Balanced', detail: 'Prefer the area currently falling furthest behind.' },
  none: { title: 'None', detail: 'No weighting; consider any useful strategy.' },
};

export function suggestionsPanel(): { panel: HTMLElement; dispose: () => void } {
  const panel = el('div', 'opt-tab-panel suggestion-settings');
  panel.setAttribute('role', 'tabpanel');
  panel.append(el('p', 'vowel-settings-copy', 'Let the AI offer optional, state-aware strategy proposals. Suggestions never issue orders until you confirm them.'));

  const toggleRow = el('label', 'opt-row suggestion-toggle');
  const enabled = el('input') as HTMLInputElement;
  enabled.type = 'checkbox';
  enabled.addEventListener('change', () => suggestionPreferences.update({ enabled: enabled.checked }));
  toggleRow.append(enabled, el('span', 'opt-label', 'Strategy suggestions'));
  panel.append(toggleRow, el('h3', '', 'Strategy bias'));

  const choices = el('div', 'suggestion-biases');
  const radios = new Map<SuggestionBias, HTMLInputElement>();
  for (const bias of suggestionBiases) {
    const option = el('label', 'suggestion-bias');
    const radio = el('input') as HTMLInputElement;
    radio.type = 'radio'; radio.name = 'strategy-suggestion-bias'; radio.value = bias;
    radio.addEventListener('change', () => { if (radio.checked) suggestionPreferences.update({ bias }); });
    const copy = el('span', 'suggestion-bias-copy');
    copy.append(el('strong', '', labels[bias].title), el('small', '', labels[bias].detail));
    option.append(radio, copy); choices.append(option); radios.set(bias, radio);
  }
  const error = el('p', 'vowel-settings-status error'); error.setAttribute('role', 'status');
  panel.append(choices, el('p', 'opt-hint', 'The advisor only uses player-visible information and rechecks a proposal before speaking.'), error);

  const render = () => {
    const prefs = suggestionPreferences.get();
    enabled.checked = prefs.enabled;
    choices.classList.toggle('disabled', !prefs.enabled);
    for (const [bias, radio] of radios) { radio.checked = bias === prefs.bias; radio.disabled = !prefs.enabled; }
    error.textContent = suggestionPreferences.error ?? ''; error.classList.toggle('hidden', !suggestionPreferences.error);
  };
  const off = suggestionPreferences.subscribe(render); render();
  return { panel, dispose: off };
}

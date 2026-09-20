// Overlay do menu de OPÇÕES (volume de música/efeitos + resolução). Global —
// aberto pela engrenagem em qualquer tela. Modelado no ConnLostOverlay.

import { el } from '../ui';
import { settings, RENDER_SCALES, LANGS, type Lang } from '../settings';
import { t } from '../i18n';
import {
  DEFAULT_VOWEL_URL,
  clearVowelConnection,
  configureVowel,
  readVowelConnection,
  showVowel,
} from '../vowel';

/** Rótulo de cada idioma no seletor (sempre no próprio idioma — assim qualquer
 *  um se reconhece, independente de quem está lendo). */
const LANG_LABELS: Record<Lang, string> = { pt: 'Português', en: 'English', es: 'Español' };

export interface SettingsDeps {
  onMusicVol: (v: number) => void;   // 0..1
  onSfxVol: (v: number) => void;     // 0..1
  onRenderScale: (s: number) => void; // 1 | 0.75 | 0.5
  onLang: (lang: Lang) => void;       // troca de idioma (main decide reload x ao vivo)
  onLeaveRoom: () => void;            // "Sair da sala" (em jogo = desistir); main manda leaveRoom
}

export class SettingsOverlay {
  readonly el: HTMLElement;
  private scaleBtns: { s: number; btn: HTMLButtonElement }[] = [];
  private card: HTMLElement;
  // "Sair da sala": só aparece em sala/jogo; em jogo pede confirmação de 2 toques.
  private leaveBtn?: HTMLButtonElement;
  private canLeave = false;
  private leaveInGame = false;
  private confirming = false;
  private activeTab: 'room' | 'vowel' = 'room';

  constructor(private deps: SettingsDeps) {
    this.el = el('div', 'overlay hidden');
    this.card = this.buildCard();
    this.el.appendChild(this.card);
    // clicar fora do card fecha
    this.el.addEventListener('mousedown', (e) => { if (e.target === this.el) this.hide(); });
  }

  /** Monta (ou remonta) o cartão de opções no idioma atual. */
  private buildCard(): HTMLElement {
    this.scaleBtns = [];
    const card = el('div', 'panel card opt-card');
    card.appendChild(el('h2', '', t('opt.title')));

    const tabs = el('div', 'opt-tabs');
    tabs.setAttribute('role', 'tablist');
    const roomTab = el('button', 'opt-tab', t('opt.room_tab')) as HTMLButtonElement;
    const vowelTab = el('button', 'opt-tab', 'Vowel') as HTMLButtonElement;
    roomTab.type = 'button';
    vowelTab.type = 'button';
    roomTab.setAttribute('role', 'tab');
    vowelTab.setAttribute('role', 'tab');
    tabs.append(roomTab, vowelTab);
    card.appendChild(tabs);

    const roomPanel = el('div', 'opt-tab-panel');
    roomPanel.setAttribute('role', 'tabpanel');
    const vowelPanel = el('div', 'opt-tab-panel vowel-settings');
    vowelPanel.setAttribute('role', 'tabpanel');

    // "Sair da sala" — no topo, só visível em sala/jogo (main chama setLeaveContext).
    // Em jogo, sair = desistir (o adversário ganha), então pede confirmação de 2 toques.
    this.confirming = false;
    const leaveBtn = el('button', 'btn danger', t('room.leave'));
    leaveBtn.classList.toggle('hidden', !this.canLeave);
    leaveBtn.addEventListener('click', () => {
      if (this.leaveInGame && !this.confirming) {
        this.confirming = true;
        leaveBtn.textContent = t('room.leave_confirm');
        return;
      }
      this.confirming = false;
      this.deps.onLeaveRoom();
    });
    this.leaveBtn = leaveBtn;
    roomPanel.appendChild(leaveBtn);

    // Idioma da interface. A troca vai pro main via onLang: fora do jogo ele
    // recarrega (reconecta ao lobby); no jogo, troca ao vivo sem derrubar a partida.
    const langRow = el('div', 'opt-row');
    langRow.appendChild(el('span', 'opt-label', t('opt.language')));
    const langBtns = el('div', 'opt-scales');
    for (const l of LANGS) {
      const btn = el('button', 'btn scale-btn', LANG_LABELS[l]);
      btn.classList.toggle('active', l === settings.lang);
      btn.addEventListener('click', () => {
        if (l === settings.lang) return;
        this.deps.onLang(l);
      });
      langBtns.appendChild(btn);
    }
    langRow.appendChild(langBtns);
    roomPanel.appendChild(langRow);

    roomPanel.appendChild(this.volumeRow(t('opt.music'), settings.musicVol, (v) => this.deps.onMusicVol(v)));
    roomPanel.appendChild(this.volumeRow(t('opt.sfx'), settings.sfxVol, (v) => this.deps.onSfxVol(v)));

    // Resolução (qualidade/desempenho)
    const res = el('div', 'opt-row');
    res.appendChild(el('span', 'opt-label', t('opt.resolution')));
    const scales = el('div', 'opt-scales');
    for (const s of RENDER_SCALES) {
      const btn = el('button', 'btn scale-btn', `${Math.round(s * 100)}%`);
      btn.addEventListener('click', () => { this.deps.onRenderScale(s); this.markScale(s); });
      this.scaleBtns.push({ s, btn });
      scales.appendChild(btn);
    }
    res.appendChild(scales);
    roomPanel.appendChild(res);
    this.markScale(settings.renderScale);

    const hint = el('p', 'opt-hint', t('opt.res_hint'));
    roomPanel.appendChild(hint);

    let connection = readVowelConnection();
    const intro = el('p', 'vowel-settings-copy', t('opt.vowel_intro'));
    vowelPanel.appendChild(intro);

    const urlLabel = el('label', 'vowel-field');
    urlLabel.appendChild(el('span', '', t('opt.vowel_url')));
    const urlInput = el('input', 'txt vowel-input') as HTMLInputElement;
    urlInput.type = 'url';
    urlInput.setAttribute('autocomplete', 'url');
    urlInput.value = connection?.baseURL ?? DEFAULT_VOWEL_URL;
    urlInput.placeholder = DEFAULT_VOWEL_URL;
    urlLabel.appendChild(urlInput);
    vowelPanel.appendChild(urlLabel);

    const keyLabel = el('label', 'vowel-field');
    keyLabel.appendChild(el('span', '', t('opt.vowel_key')));
    const keyInput = el('input', 'txt vowel-input') as HTMLInputElement;
    keyInput.type = 'password';
    keyInput.autocomplete = 'off';
    keyInput.placeholder = connection ? t('opt.vowel_key_saved') : t('opt.vowel_key_placeholder');
    keyLabel.appendChild(keyInput);
    vowelPanel.appendChild(keyLabel);

    const status = el(
      'p',
      `vowel-settings-status${connection ? ' connected' : ''}`,
      connection ? t('opt.vowel_connected', { profile: connection.profileName }) : t('opt.vowel_not_connected'),
    );
    status.setAttribute('role', 'status');
    vowelPanel.appendChild(status);

    const vowelActions = el('div', 'vowel-settings-actions');
    const connect = el('button', 'btn primary', t('opt.vowel_connect')) as HTMLButtonElement;
    connect.type = 'button';
    connect.addEventListener('click', async () => {
      connect.disabled = true;
      status.className = 'vowel-settings-status';
      status.textContent = t('opt.vowel_checking');
      try {
        connection = await configureVowel(keyInput.value || connection?.apiKey || '', urlInput.value);
        keyInput.value = '';
        keyInput.placeholder = t('opt.vowel_key_saved');
        status.className = 'vowel-settings-status connected';
        status.textContent = t('opt.vowel_connected', { profile: connection.profileName });
        showBtn.classList.remove('hidden');
        disconnect.classList.remove('hidden');
      } catch (cause) {
        status.className = 'vowel-settings-status error';
        status.textContent = cause instanceof Error ? cause.message : String(cause);
      } finally {
        connect.disabled = false;
      }
    });
    const showBtn = el('button', `btn${connection ? '' : ' hidden'}`, t('opt.vowel_show')) as HTMLButtonElement;
    showBtn.type = 'button';
    showBtn.addEventListener('click', () => {
      showVowel();
      this.hide();
    });
    const disconnect = el('button', `btn danger${connection ? '' : ' hidden'}`, t('opt.vowel_disconnect')) as HTMLButtonElement;
    disconnect.type = 'button';
    disconnect.addEventListener('click', () => {
      clearVowelConnection();
      connection = null;
      keyInput.value = '';
      keyInput.placeholder = t('opt.vowel_key_placeholder');
      status.className = 'vowel-settings-status';
      status.textContent = t('opt.vowel_not_connected');
      showBtn.classList.add('hidden');
      disconnect.classList.add('hidden');
    });
    vowelActions.append(connect, showBtn, disconnect);
    vowelPanel.appendChild(vowelActions);
    vowelPanel.appendChild(el('p', 'vowel-secret-note', t('opt.vowel_session_note')));

    const selectTab = (tab: 'room' | 'vowel') => {
      this.activeTab = tab;
      const roomActive = tab === 'room';
      roomTab.classList.toggle('active', roomActive);
      vowelTab.classList.toggle('active', !roomActive);
      roomTab.setAttribute('aria-selected', String(roomActive));
      vowelTab.setAttribute('aria-selected', String(!roomActive));
      roomPanel.classList.toggle('hidden', !roomActive);
      vowelPanel.classList.toggle('hidden', roomActive);
    };
    roomTab.addEventListener('click', () => selectTab('room'));
    vowelTab.addEventListener('click', () => selectTab('vowel'));
    selectTab(this.activeTab);
    card.append(roomPanel, vowelPanel);

    const close = el('button', 'btn primary', t('opt.close'));
    close.addEventListener('click', () => this.hide());
    card.appendChild(close);
    return card;
  }

  /** Re-traduz o próprio menu ao vivo (usado quando o idioma muda no jogo, sem reload). */
  retranslate(): void {
    const fresh = this.buildCard();
    this.card.replaceWith(fresh);
    this.card = fresh;
  }

  private volumeRow(label: string, initial: number, onChange: (v: number) => void): HTMLElement {
    const row = el('div', 'opt-row');
    row.appendChild(el('span', 'opt-label', label));
    const slider = el('input', 'opt-slider');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.value = String(Math.round(initial * 100));
    const pct = el('span', 'opt-pct', `${slider.value}%`);
    slider.addEventListener('input', () => {
      pct.textContent = `${slider.value}%`;
      onChange(Number(slider.value) / 100);
    });
    row.appendChild(slider);
    row.appendChild(pct);
    return row;
  }

  private markScale(s: number): void {
    for (const { s: bs, btn } of this.scaleBtns) btn.classList.toggle('active', Math.abs(bs - s) < 0.001);
  }

  /** main avisa em qual tela estamos: mostra "Sair da sala" só em sala/jogo, e liga
   *  a confirmação de 2 toques quando em jogo (sair = desistir da partida). */
  setLeaveContext(canLeave: boolean, inGame: boolean): void {
    this.canLeave = canLeave;
    this.leaveInGame = inGame;
    this.confirming = false;
    if (this.leaveBtn) {
      this.leaveBtn.classList.toggle('hidden', !canLeave);
      this.leaveBtn.textContent = t('room.leave');
    }
  }

  show(tab?: 'room' | 'vowel'): void {
    if (tab && tab !== this.activeTab) {
      this.activeTab = tab;
      const fresh = this.buildCard();
      this.card.replaceWith(fresh);
      this.card = fresh;
    }
    // reabrir zera a confirmação pendente (evita sair no 1º toque de uma abertura antiga)
    this.confirming = false;
    if (this.leaveBtn) this.leaveBtn.textContent = t('room.leave');
    this.el.classList.remove('hidden');
  }

  hide(): void {
    this.el.classList.add('hidden');
  }

  get isOpen(): boolean {
    return !this.el.classList.contains('hidden');
  }
}

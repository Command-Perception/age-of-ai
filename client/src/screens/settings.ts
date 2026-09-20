// Overlay do menu de OPÇÕES (volume de música/efeitos + resolução). Global —
// aberto pela engrenagem em qualquer tela. Modelado no ConnLostOverlay.

import { el } from '../ui';
import { settings, RENDER_SCALES, LANGS, type Lang } from '../settings';
import { t } from '../i18n';
import {
  DEFAULT_VOWEL_URL,
  VowelNetworkError,
  clearVowelConnection,
  configureVowel,
  readVowelConnection,
  showVowel,
} from '../vowel';

/** Rótulo de cada idioma no seletor (sempre no próprio idioma — assim qualquer
 *  um se reconhece, independente de quem está lendo). */
const LANG_LABELS: Record<Lang, string> = { pt: 'Português', en: 'English', es: 'Español' };

const EYE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6S2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.75"/></svg>';
const EYE_OFF_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 18M10.6 6.1A11.8 11.8 0 0 1 12 6c6 0 9.5 6 9.5 6a16.8 16.8 0 0 1-3.1 3.7M6.2 6.3C3.8 8 2.5 12 2.5 12s3.5 6 9.5 6c1.2 0 2.3-.2 3.3-.6M9.9 9.8a3 3 0 0 0 4.2 4.3"/></svg>';
const CLEAR_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>';
const COPY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';

function iconButton(className: string, label: string, icon: string): HTMLButtonElement {
  const button = el('button', className) as HTMLButtonElement;
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.innerHTML = icon;
  return button;
}

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
    const keyShell = el('div', 'vowel-key-input-shell');
    const keyControls = el('div', 'vowel-key-input-controls');
    const serverKeyWarning = el('div', 'vowel-key-warning hidden', t('opt.vowel_server_key_warning'));
    serverKeyWarning.setAttribute('role', 'status');
    const toggleKey = iconButton('vowel-input-icon-btn', t('opt.vowel_key_show'), EYE_ICON);
    const clearKey = iconButton('vowel-input-icon-btn', t('opt.vowel_key_clear'), CLEAR_ICON);
    const syncKeyControls = () => {
      const hasValue = keyInput.value.length > 0;
      keyShell.classList.toggle('has-value', hasValue);
      clearKey.disabled = !hasValue;
      serverKeyWarning.classList.toggle('hidden', !keyInput.value.trim().startsWith('vk_'));
    };
    toggleKey.addEventListener('click', () => {
      const showing = keyInput.type === 'text';
      keyInput.type = showing ? 'password' : 'text';
      const label = t(showing ? 'opt.vowel_key_show' : 'opt.vowel_key_hide');
      toggleKey.title = label;
      toggleKey.setAttribute('aria-label', label);
      toggleKey.innerHTML = showing ? EYE_ICON : EYE_OFF_ICON;
      keyInput.focus();
    });
    clearKey.addEventListener('click', () => {
      keyInput.value = '';
      syncKeyControls();
      keyInput.focus();
    });
    keyInput.addEventListener('input', syncKeyControls);
    keyControls.append(toggleKey, clearKey);
    keyShell.append(keyInput, keyControls);
    keyLabel.append(keyShell, serverKeyWarning);
    vowelPanel.appendChild(keyLabel);

    const status = el('div', 'vowel-settings-status');
    const statusMessage = el('span', 'vowel-settings-status-message');
    const copyStatus = iconButton('vowel-status-copy hidden', t('opt.vowel_error_copy'), COPY_ICON);
    let lastError = '';
    let copiedTimer: number | undefined;
    const setStatus = (kind: 'plain' | 'connected' | 'error', message: string) => {
      status.className = `vowel-settings-status${kind === 'plain' ? '' : ` ${kind}`}`;
      statusMessage.textContent = message;
      lastError = kind === 'error' ? message : '';
      copyStatus.classList.toggle('hidden', kind !== 'error');
      copyStatus.title = t('opt.vowel_error_copy');
      copyStatus.setAttribute('aria-label', t('opt.vowel_error_copy'));
      copyStatus.innerHTML = COPY_ICON;
    };
    copyStatus.addEventListener('click', async () => {
      if (!lastError) return;
      try {
        await navigator.clipboard.writeText(lastError);
        const copiedLabel = t('opt.vowel_error_copied');
        copyStatus.title = copiedLabel;
        copyStatus.setAttribute('aria-label', copiedLabel);
        copyStatus.innerHTML = CHECK_ICON;
        if (copiedTimer !== undefined) window.clearTimeout(copiedTimer);
        copiedTimer = window.setTimeout(() => {
          copyStatus.title = t('opt.vowel_error_copy');
          copyStatus.setAttribute('aria-label', t('opt.vowel_error_copy'));
          copyStatus.innerHTML = COPY_ICON;
        }, 1400);
      } catch {
        // Clipboard access can be denied by the browser; leave the error intact.
      }
    });
    status.append(statusMessage, copyStatus);
    status.setAttribute('role', 'status');
    setStatus(
      connection ? 'connected' : 'plain',
      connection ? t('opt.vowel_connected', { profile: connection.profileName }) : t('opt.vowel_not_connected'),
    );
    vowelPanel.appendChild(status);

    const vowelActions = el('div', 'vowel-settings-actions');
    const connect = el('button', 'btn primary', t('opt.vowel_connect')) as HTMLButtonElement;
    connect.type = 'button';
    connect.addEventListener('click', async () => {
      connect.disabled = true;
      setStatus('plain', t('opt.vowel_checking'));
      try {
        connection = await configureVowel(keyInput.value || connection?.apiKey || '', urlInput.value);
        keyInput.value = '';
        syncKeyControls();
        keyInput.placeholder = t('opt.vowel_key_saved');
        setStatus('connected', t('opt.vowel_connected', { profile: connection.profileName }));
        showBtn.classList.remove('hidden');
        disconnect.classList.remove('hidden');
      } catch (cause) {
        const message = cause instanceof VowelNetworkError
          ? t('opt.vowel_unreachable', { url: cause.baseURL })
          : cause instanceof Error ? cause.message : String(cause);
        setStatus('error', message);
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
      syncKeyControls();
      keyInput.placeholder = t('opt.vowel_key_placeholder');
      setStatus('plain', t('opt.vowel_not_connected'));
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

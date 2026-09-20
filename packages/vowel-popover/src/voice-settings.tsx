import { Pcm16Player } from "./pcm16-playback";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Check, ChevronsUpDown, Play, Square, LoaderCircle, Star, ChevronRight, Lock } from "lucide-react";
import { Button } from "./components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./components/ui/command";
import { Field, FieldGroup, FieldLabel } from "./components/ui/field";
import type { RecordItem } from "./host/control-plane";
import type { VoiceOption, VoiceSettingsStore } from "./voice-settings-store";

export const VoiceSettings = ({ store, onProfileChange, profileLocked = false }: { readonly store: VoiceSettingsStore; readonly onProfileChange: () => void; readonly profileLocked?: boolean }) => {
  const { profile, voice, favorites } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [profiles, setProfiles] = useState<RecordItem[]>([]);
  const [profileError, setProfileError] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [provider, setProvider] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [retry, setRetry] = useState(0);
  const [previewState, setPreviewState] = useState<"idle" | "loading" | "playing">("idle");
  const [previewError, setPreviewError] = useState("");
  const previewRef = useRef<{ controller: AbortController; player?: Pcm16Player; reader?: ReadableStreamDefaultReader<Uint8Array> } | null>(null);
  const stopPreview = useCallback(() => {
    const preview = previewRef.current;
    previewRef.current = null;
    preview?.controller.abort();
    void preview?.reader?.cancel().catch(() => undefined);
    preview?.player?.close();
    setPreviewState("idle");
  }, []);
  useEffect(() => { stopPreview(); setPreviewError(""); return stopPreview; }, [profile.id, voice?.id, stopPreview]);
  const playPreview = async () => {
    if (previewRef.current) { stopPreview(); return; }
    setPreviewError("");
    setPreviewState("loading");
    const preview: { controller: AbortController; player?: Pcm16Player; reader?: ReadableStreamDefaultReader<Uint8Array> } = { controller: new AbortController() };
    previewRef.current = preview;
    try {
      const context = new AudioContext({ sampleRate: 24_000 });
      preview.player = new Pcm16Player(context);
      await context.resume();
      if (preview.controller.signal.aborted) return;
      const stream = await store.previewVoice(preview.controller.signal);
      if (preview.controller.signal.aborted) { await stream.cancel(); return; }
      preview.reader = stream.getReader();
      try {
        for (;;) {
          const next = await preview.reader.read();
          if (preview.controller.signal.aborted) return;
          if (next.done) break;
          if (preview.player.playBytes(next.value)) setPreviewState("playing");
        }
      } finally { preview.reader.releaseLock(); delete preview.reader; }
      await preview.player.drain();
      if (!preview.controller.signal.aborted) stopPreview();
    } catch (error) {
      if (!preview.controller.signal.aborted) { setPreviewError(error instanceof Error ? `Preview failed: ${error.message}` : "Could not preview this voice. Please try again."); stopPreview(); }
    }
  };


  useEffect(() => {
    let disposed = false;
    void store.listProfiles().then(({ data }) => {
      if (disposed) return;
      setProfiles(data);
      setProfileError("");
      // The placeholder start profile may not exist in this environment; fall
      // back to the catalog's first entry so profile-scoped queries resolve.
      if (data.length > 0 && !data.some((item) => item.id === store.getSnapshot().profile.id))
        store.selectProfile(data[0]!);
    }).catch(() => { if (!disposed) setProfileError("Could not load session profiles."); });
    return () => { disposed = true; };
  }, [store, retry]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const timer = window.setTimeout(() => {
      void store.listVoices(query, page, controller.signal).then((result) => {
        if (controller.signal.aborted) return;
        setVoices((previous) => page === 1 ? result.data : [...previous, ...result.data.filter((item) => !previous.some((old) => old.id === item.id))]);
        setProvider(result.provider);
        setHasMore(result.hasMore);
        setLoading(false);
      }).catch(() => {
        if (controller.signal.aborted) return;
        setError("Could not load voices. Try again.");
        setLoading(false);
      });
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [store, profile.id, query, page, retry]);

  const favoriteCompatible = (item: VoiceOption) =>
    !provider || (provider === "Fish Audio" ? item.id.startsWith("fish:") : provider === "Deepgram" ? item.id.startsWith("deepgram:") : provider === "Cloudflare Aura-2" ? item.id.startsWith("aura:") : true);
  const changeQuery = (value: string) => { setQuery(value); setPage(1); setVoices([]); setHasMore(false); };
  return (
    <div className="border-t px-4 py-4" aria-label="Conversation settings">
      <h2 className="mb-4 text-sm font-medium">Conversation settings</h2>
      <FieldGroup className="gap-4">
        <Field>
          <FieldLabel>Session profile</FieldLabel>
          {profileLocked ? (
            // The API key used to mint voice sessions owns a fixed profile, so
            // choosing a different one would fail minting anyway.
            <span role="status" aria-label="Session profile (fixed by the API key)" className="flex min-h-9 w-full items-center justify-between gap-2 rounded-[6px] border bg-transparent px-3 py-2 opacity-70">
              <span className="truncate">{profile.name || profile.id}</span>
              <Lock className="size-4 shrink-0" />
            </span>
          ) : (
          <Popover open={profileOpen} onOpenChange={setProfileOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" role="combobox" aria-label="Session profile" aria-expanded={profileOpen} className="w-full justify-between">
                <span className="truncate">{profile.name || profile.id}</span><ChevronsUpDown />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
              <Command>
                <CommandInput placeholder="Search session profiles…" />
                <CommandList>
                  <CommandEmpty>{profileError || "No profiles found."}</CommandEmpty>
                  <CommandGroup>
                    {profiles.map((item) => <CommandItem key={item.id} value={`${item.name ?? ""} ${item.id} ${item.model ?? ""}`} onSelect={() => {
                      if (item.id !== profile.id) { onProfileChange(); store.selectProfile(item); setProvider(""); changeQuery(""); }
                      setProfileOpen(false);
                    }}>
                      <span className="min-w-0 flex-1 truncate">{item.name || item.id}</span>{item.id === profile.id && <Check />}
                    </CommandItem>)}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          )}
          {!profileLocked && profileError && <Button variant="ghost" size="sm" onClick={() => setRetry((value) => value + 1)}>Retry profiles</Button>}
          {profileLocked && profileError && <span className="p-2 text-sm text-muted-foreground" role="status">{profileError}</span>}
        </Field>
        <Field>
          <FieldLabel>Voice</FieldLabel>
          <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" disabled={!voice} aria-label={favorites.some((item) => item.id === voice?.id) ? "Remove selected voice from favorites" : "Favorite selected voice"} aria-pressed={favorites.some((item) => item.id === voice?.id)} onClick={() => { if (voice) store.toggleFavorite(voice); }}>
            <Star fill={favorites.some((item) => item.id === voice?.id) ? "currentColor" : "none"} />
          </Button>
          <Popover open={voiceOpen} onOpenChange={setVoiceOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" role="combobox" aria-label="Voice" aria-expanded={voiceOpen} className="min-w-0 flex-1 justify-between">
                <span className="truncate">{voice?.name ?? "Provider default"}</span><ChevronsUpDown />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
              <Command shouldFilter={false}>
                <CommandInput placeholder="Search available voices…" value={query} onValueChange={changeQuery} />
                <CommandList>
                  <CommandGroup>
                    {!query && <CommandItem value="default" onSelect={() => { store.selectVoice(null); setVoiceOpen(false); }}>Provider default{!voice && <Check />}</CommandItem>}
                    {voices.map((item) => <CommandItem key={item.id} value={item.id} onSelect={() => { store.selectVoice(item); setVoiceOpen(false); }}>
                      <span className="flex min-w-0 flex-1 flex-col"><span className="truncate">{item.name}</span><span className="truncate text-xs text-muted-foreground">{item.detail}</span></span>
                      {voice?.id === item.id && <Check />}
                    </CommandItem>)}
                  </CommandGroup>
                  {loading && <p role="status" className="p-3 text-sm text-muted-foreground">Loading voices…</p>}
                  {error && <div role="alert" className="p-3 text-sm">{error}<Button variant="ghost" size="sm" onClick={() => setRetry((value) => value + 1)}>Retry</Button></div>}
                  {!loading && !error && voices.length === 0 && <p className="p-3 text-sm text-muted-foreground">No voices found.</p>}
                  {hasMore && !loading && !error && <Button variant="ghost" className="w-full" onClick={() => setPage((value) => value + 1)}>Load more voices</Button>}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          <Button variant="outline" size="icon" aria-label={previewState === "idle" ? "Preview selected voice" : "Stop voice preview"} title={previewState === "idle" ? "Preview selected voice" : "Stop voice preview"} onClick={() => { void playPreview(); }}>
            {previewState === "loading" ? <LoaderCircle className="animate-spin" /> : previewState === "playing" ? <Square /> : <Play />}
          </Button>

          </div>
          {previewState === "loading" && <p role="status" className="text-xs text-muted-foreground">Preparing voice preview…</p>}
          {previewError && <p role="alert" className="text-xs text-destructive">{previewError}</p>}
        </Field>
        <details className="group rounded-md border">
          <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md p-3 text-sm font-medium focus-ring [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-4 transition-transform group-open:rotate-90" />Favorites <span className="text-muted-foreground">({favorites.length})</span>
          </summary>
          <div className="flex max-h-48 flex-col gap-1 overflow-y-auto px-2 pb-2">
            {favorites.length === 0 && <p className="px-1 py-2 text-xs text-muted-foreground">Select a voice and tap the star to save it here.</p>}
            {favorites.map((item) => <div key={item.id} className="flex items-center gap-1">
              <Button variant="ghost" size="icon" aria-label={`Remove ${item.name} from favorites`} onClick={() => store.toggleFavorite(item)}><Star fill="currentColor" /></Button>
              <Button variant="ghost" className="min-w-0 flex-1 justify-start" disabled={!favoriteCompatible(item)} title={favoriteCompatible(item) ? item.detail : "Choose a session profile that supports this voice"} onClick={() => store.selectVoice(item)}>
                {voice?.id === item.id && <Check />}<span className="truncate">{item.name}</span>
              </Button>

            </div>)}
          </div>
        </details>
      </FieldGroup>
    </div>
  );
};

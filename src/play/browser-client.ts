import type {
  ActionParams,
  CampaignSummary,
  PlayerView,
  SaveHandle,
  Scene,
  SessionActionResult,
  SessionHandle,
  SessionStore,
  StringTable,
} from "@the-running-dev/game-engine";

export interface PlayAction {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
  readonly reason?: string;
}

export interface PlayState {
  readonly sessionId: string;
  readonly scene: Scene;
  readonly strings: StringTable;
  readonly view: PlayerView;
  readonly actions: readonly PlayAction[];
}

/** The public demo always renders the player projection and has no profile surface. */
export interface BrowserSessionConfig {
  readonly campaignId: string;
  readonly seed?: string;
}

export class BrowserClient {
  private readonly store: SessionStore;

  constructor(store: SessionStore) {
    this.store = store;
  }

  listCampaigns(): CampaignSummary[] {
    return this.store.listCampaigns();
  }

  async createSession(config: BrowserSessionConfig): Promise<PlayState> {
    return this.read(
      await this.store.createSession({
        campaignId: config.campaignId,
        ...(config.seed === undefined ? {} : { seed: config.seed }),
        audience: "player",
      }),
    );
  }

  async start(campaignId: string): Promise<PlayState> {
    return this.createSession({ campaignId });
  }

  async resumeSession(sessionId: string): Promise<PlayState> {
    const scene = await this.store.resumeSession(sessionId);
    return this.read({ sessionId, scene });
  }

  getScene(sessionId: string): Promise<Scene> {
    return this.store.getScene(sessionId);
  }

  getView(sessionId: string): Promise<PlayerView> {
    return this.store.getView(sessionId);
  }

  getStrings(sessionId: string): Promise<StringTable> {
    return this.store.getStrings(sessionId);
  }

  previewAction(
    sessionId: string,
    actionId: string,
    params?: ActionParams,
  ): Promise<SessionActionResult> {
    return this.store.previewAction(sessionId, actionId, params);
  }

  submitAction(
    sessionId: string,
    actionId: string,
    params?: ActionParams,
  ): Promise<SessionActionResult> {
    return this.store.submitAction(sessionId, actionId, params);
  }

  async submit(
    state: PlayState,
    actionId: string,
    params?: ActionParams,
  ): Promise<{ state: PlayState; result: SessionActionResult }> {
    const result = await this.submitAction(state.sessionId, actionId, params);
    return {
      state: await this.read({
        sessionId: state.sessionId,
        scene: result.scene ?? state.scene,
      }),
      result,
    };
  }

  async preview(
    state: PlayState,
    actionId: string,
    params?: ActionParams,
  ): Promise<Scene | undefined> {
    return (await this.previewAction(state.sessionId, actionId, params)).scene;
  }

  saveGame(sessionId: string): Promise<SaveHandle> {
    return this.store.saveGame(sessionId);
  }

  save(sessionId: string): Promise<SaveHandle> {
    return this.saveGame(sessionId);
  }

  async loadGame(saveId: string): Promise<PlayState> {
    return this.read(await this.store.loadGame(saveId));
  }

  load(saveId: string): Promise<PlayState> {
    return this.loadGame(saveId);
  }

  private async read(handle: SessionHandle): Promise<PlayState> {
    const [scene, view, strings] = await Promise.all([
      this.store.getScene(handle.sessionId),
      this.store.getView(handle.sessionId),
      this.store.getStrings(handle.sessionId),
    ]);
    return {
      sessionId: handle.sessionId,
      scene,
      view,
      strings,
      actions: scene.actions.map((action) => ({
        id: action.id,
        label: strings[action.labelKey] ?? "Unavailable action",
        available: action.available,
        ...(action.reasonKey === undefined
          ? {}
          : {
              reason:
                strings[action.reasonKey] ?? "This action is not available.",
            }),
      })),
    };
  }
}

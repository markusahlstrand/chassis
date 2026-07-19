/**
 * A minimal dynamic-dispatch worker — the router's role, reduced to nothing but
 * the dispatch, so that a failure here is unambiguous.
 *
 * Its only job is to prove the second half of the question: the user worker was
 * accepted, but does its Durable Object actually instantiate and serve SQL from
 * inside a dispatch namespace?
 */
export interface Env {
  DISPATCH: { get(name: string): Fetcher };
  SCRIPT_NAME?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const name = env.SCRIPT_NAME ?? 'spike-vertical';
    try {
      const user = env.DISPATCH.get(name);
      return await user.fetch(request);
    } catch (e) {
      // A missing script and a broken DO fail very differently; say which.
      return Response.json(
        { ok: false, stage: 'dispatch', script: name, error: (e as Error).message },
        { status: 500 },
      );
    }
  },
};

// Unit tests import the Worker entrypoint in Node. Production bundles resolve
// `cloudflare:workers` in workerd; this minimal base is only a module-loader shim.
export class DurableObject<Env = unknown> {
  protected readonly ctx: DurableObjectState;
  protected readonly env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

import { ModelRuntime } from "../pi-sdk.js";

type IsolationCheck = () => boolean | Promise<boolean>;

/** Authenticate selected profiles outside models.json composition. Wrapping a native
 * provider alone is insufficient: Pi applies configured keys and headers above it. */
export async function protectPiProfileRuntime(runtime: ModelRuntime, isolated: IsolationCheck,
  storage: Pick<NonNullable<Parameters<typeof ModelRuntime.create>[0]>, "credentials" | "authPath">): Promise<void> {
  const authority = await ModelRuntime.create({ ...storage, modelsPath: null, refreshOnCreate: false });
  const registrations = new Map<string, unknown>();
  const guarded = new WeakSet<object>();
  async function syncProviders() {
    let changed = false;
    const registered = new Set(runtime.getRegisteredProviderIds());
    for (const id of registrations.keys()) if (!registered.has(id)) { authority.unregisterProvider(id); registrations.delete(id); changed = true; }
    for (const id of registered) {
      const native = runtime.getRegisteredNativeProvider(id);
      const config = runtime.getRegisteredProviderConfig(id);
      const registration = native ?? config;
      if (registrations.get(id) === registration) continue;
      if (native) authority.registerNativeProvider(native);
      else if (config) {
        // Keep app-configured provider protocol/models/OAuth, never its account overrides.
        const { apiKey: _key, headers: _headers, ...definition } = config;
        authority.registerProvider(id, { ...definition,
          models: definition.models?.map(({ headers: _modelHeaders, ...model }) => model),
        });
      }
      registrations.set(id, registration);
      changed = true;
    }
    // Custom model files may define a protocol without an extension. Copy the protocol, not its account overrides.
    for (const provider of runtime.getProviders()) {
      if (authority.getProvider(provider.id)) continue;
      const models = runtime.getModels(provider.id);
      if (!models.length) continue;
      authority.registerProvider(provider.id, {
        api: models[0].api, baseUrl: models[0].baseUrl,
        models: models.map(({ headers: _headers, ...model }) => model),
      });
      changed = true;
    }
    for (const provider of authority.getProviders()) {
      const apiKey = provider.auth.apiKey;
      if (!apiKey || guarded.has(provider)) continue;
      const scoped = (input: Parameters<typeof apiKey.resolve>[0]) => ({ ...input,
        ctx: { env: async (name: string) => input.credential!.env?.[name], fileExists: async () => false } });
      authority.registerNativeProvider({ ...provider, auth: { ...provider.auth, apiKey: { ...apiKey,
        check: async (input) => {
          if (!input.credential) return undefined;
          return apiKey.check ? apiKey.check(scoped(input)) : apiKey.resolve(scoped(input)).then((result) => result ? { type: "api_key" as const, source: result.source } : undefined);
        },
        resolve: async (input) => input.credential ? apiKey.resolve(scoped(input)) : undefined,
      } } });
      guarded.add(authority.getProvider(provider.id)!);
      changed = true;
    }
    // Registration schedules availability passes. Finish them before returning the guarded snapshot.
    if (changed) await authority.refresh({ allowNetwork: false });
  }
  const auth = runtime.getAuth.bind(runtime);
  runtime.getAuth = async (provider: string | Parameters<ModelRuntime["getAuth"]>[0], options?: Parameters<ModelRuntime["getAuth"]>[1]) => {
    if (!await isolated()) return typeof provider === "string" ? auth(provider, options) : auth(provider, options);
    await syncProviders();
    return authority.getAuth(typeof provider === "string" ? provider : provider.provider, { ...options, apiKey: undefined, env: undefined });
  };
  const check = runtime.checkAuth.bind(runtime);
  runtime.checkAuth = async (provider, options) => {
    if (!await isolated()) return check(provider, options);
    await syncProviders(); return authority.checkAuth(provider, options);
  };
  const available = runtime.getAvailable.bind(runtime);
  runtime.getAvailable = async (provider, options) => {
    if (!await isolated()) return available(provider, options);
    await syncProviders(); return authority.getAvailable(provider, options);
  };
}

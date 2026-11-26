import { field } from "./automation-trigger.js";

/** Automation-only pool selection. Keep saved legacy profiles until explicitly replaced. */
export function createAutomationPoolPicker(anchor, testId, load) {
  const select = document.createElement("select");
  select.name = "providerPoolId";
  const wrapper = field("Run with pool", select, testId);
  anchor.after(wrapper);
  let revision = 0, failure = null;
  function options(pools, saved) {
    select.replaceChildren(new Option("Use my current pool", ""), ...pools.map(pool => new Option(pool.name, pool.id)));
    if (saved?.providerPoolId && !pools.some(pool => pool.id === saved.providerPoolId)) select.add(new Option("Unavailable pool — choose another", saved.providerPoolId));
    if (saved?.providerProfileId) select.add(new Option("Saved profile (legacy) — choose a pool to replace", `profile:${saved.providerProfileId}`));
    select.value = saved?.providerPoolId || (saved?.providerProfileId ? `profile:${saved.providerProfileId}` : "");
  }
  options([], null);
  return {
    element: wrapper,
    async refresh(saved = null) {
      const current = ++revision;
      failure = null; select.disabled = true; options([], saved);
      try {
        const body = await load();
        if (current !== revision) return;
        options(body.pools, saved);
      } catch (error) {
        if (current !== revision) return;
        failure = error;
      } finally {
        if (current === revision) select.disabled = false;
      }
    },
    value() {
      if (select.disabled) throw new Error("Subscription pools are still loading.");
      if (failure) throw new Error("Subscription pools could not be loaded. Reopen the form to retry.");
      return select.value.startsWith("profile:")
        ? { providerProfileId: select.value.slice(8), providerPoolId: null }
        : { providerProfileId: null, providerPoolId: select.value || null };
    },
  };
}

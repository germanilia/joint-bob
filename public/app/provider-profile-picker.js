import { field } from "./automation-trigger.js";

/** Automation-only, node-local profile selection. Never silently drop a saved assignment. */
export function createAutomationProfilePicker(anchor, testId, load) {
  const label = document.createElement("label");
  label.textContent = "Run with profile";
  const select = document.createElement("select");
  select.name = "providerProfileId";
  select.dataset.testid = testId;
  label.append(select);
  anchor.after(label);
  let revision = 0, failure = null;
  function options(profiles, selected) {
    select.replaceChildren(new Option("Use my current profile", ""), ...profiles.map(profile => new Option(`${profile.label}${profile.shared ? " (shared)" : ""}`, profile.id)));
    if (selected && !profiles.some(profile => profile.id === selected)) select.add(new Option("Unavailable profile — choose another", selected));
    select.value = selected || "";
  }
  options([], null);
  return {
    async refresh(selected = null) {
      const current = ++revision;
      failure = null; select.disabled = true; options([], selected);
      try {
        const body = await load();
        if (current !== revision) return;
        options(body.profiles, selected);
      } catch (error) {
        if (current !== revision) return;
        failure = error;
      } finally {
        if (current === revision) { select.disabled = false; }
      }
    },
    value() {
      if (failure) throw new Error("Provider profiles could not be loaded. Reopen the form to retry.");
      return select.value || null;
    },
  };
}

/** Automation-only pool selection. Keep saved legacy profiles until explicitly replaced. */
export function createAutomationPoolPicker(anchor, testId, load) {
  const select = document.createElement("select");
  select.name = "providerPoolId";
  anchor.after(field("Run with pool", select, testId));
  let revision = 0, failure = null;
  function options(pools, saved) {
    select.replaceChildren(new Option("Use my current pool", ""), ...pools.map(pool => new Option(pool.name, pool.id)));
    if (saved?.providerPoolId && !pools.some(pool => pool.id === saved.providerPoolId)) select.add(new Option("Unavailable pool — choose another", saved.providerPoolId));
    if (saved?.providerProfileId) select.add(new Option("Saved profile (legacy) — choose a pool to replace", `profile:${saved.providerProfileId}`));
    select.value = saved?.providerPoolId || (saved?.providerProfileId ? `profile:${saved.providerProfileId}` : "");
  }
  options([], null);
  return {
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

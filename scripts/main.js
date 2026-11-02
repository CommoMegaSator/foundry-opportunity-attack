/**
 * Opportunity Attack Reactions
 * When a creature leaves the reach of a hostile combatant, the owner of that combatant
 * gets a prompt to make a melee attack as a reaction (via Midi QOL).
 *
 * Skips: no reaction available, reactor blinded or mover heavily obscured (region with flags.opportunity-attack.obscured, e.g. Fog Cloud), incapacitated reactor, hidden mover, "Disengage" status,
 * flag `flags.opportunity-attack.noProvoke` on the mover actor, Flyby-type traits,
 * teleports / script moves (movement method "api") unless enabled in settings.
 */
const MOD = "opportunity-attack";
let socket;

const INCAPACITATED = ["incapacitated", "unconscious", "paralyzed", "stunned", "petrified", "dead"];

Hooks.once("init", () => {
  game.settings.register(MOD, "enabled", {
    name: "OPPATK.Enabled", hint: "OPPATK.EnabledHint",
    scope: "world", config: true, type: Boolean, default: true
  });
  game.settings.register(MOD, "includeApi", {
    name: "OPPATK.IncludeApi", hint: "OPPATK.IncludeApiHint",
    scope: "world", config: true, type: Boolean, default: false
  });

});

// Disengage status: no opportunity attacks against this creature. Remove it at the end of the turn.
// Registered on "ready" as well, because other modules/systems may rebuild the status list after init.
function registerDisengage() {
  if (CONFIG.statusEffects.some(s => s.id === "disengage")) return;
  CONFIG.statusEffects.push({
    id: "disengage",
    name: "OPPATK.Disengage",
    img: "icons/svg/wingfoot.svg",
    flags: { [MOD]: { noProvoke: true } }
  });
}
Hooks.once("setup", registerDisengage);
Hooks.once("ready", registerDisengage);

function ensureSocket() {
  if (socket) return socket;
  if (typeof socketlib === "undefined") return null;
  try {
    socket = socketlib.registerModule(MOD);
    socket.register("prompt", promptReaction);
  } catch (e) {
    socket = null;
    console.warn(MOD, "socketlib registration failed", e);
  }
  return socket;
}
Hooks.once("socketlib.ready", ensureSocket);
Hooks.once("setup", ensureSocket);
Hooks.once("ready", ensureSocket);

Hooks.on("updateToken", (doc, changes, options) => {
  if (!game.user.isActiveGM) return;
  if (!game.settings.get(MOD, "enabled")) return;
  if (!game.combat?.started) return;
  const mv = options?._movement?.[doc.id];
  if (!mv) return;
  if (mv.method === "api" && !game.settings.get(MOD, "includeApi")) return;
  if (!("x" in changes || "y" in changes)) return;
  checkMovement(doc, mv).catch(err => console.error(MOD, err));
});

/* ---------- geometry ---------- */

function rectOf(pos, doc) {
  const g = canvas.grid.size;
  return { x: pos.x, y: pos.y, w: (pos.width ?? doc.width) * g, h: (pos.height ?? doc.height) * g };
}

/** Distance in feet between two token rectangles (square grid, Chebyshev); adjacent = 5 ft. */
function rectDistance(a, b) {
  const g = canvas.grid.size;
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
  // Adjacent tokens (no empty square between) are 1 grid unit apart (5 ft), like D&D reach measurement.
  return (Math.round(Math.max(dx, dy) / g) + 1) * canvas.grid.distance;
}

/* ---------- reactor eligibility ---------- */

function meleeOptions(actor) {
  const out = [];
  for (const item of actor.items) {
    if (!["weapon", "feat"].includes(item.type)) continue;
    for (const act of item.system.activities ?? []) {
      if (act.type !== "attack") continue;
      if (act.attack?.type?.value !== "melee") continue;
      const reach = item.system.range?.reach || act.range?.reach || 5;
      out.push({
        itemUuid: item.uuid, activityId: act.id, name: item.name, reach: Number(reach),
        equipped: item.type !== "weapon" || actor.type !== "character" || !!item.system.equipped
      });
    }
  }
  // Characters: prefer equipped weapons; if nothing is equipped, offer every melee weapon.
  const eq = out.filter(o => o.equipped);
  return eq.length ? eq : out;
}

function canReact(actor) {
  if (!actor) return false;
  if (INCAPACITATED.some(s => actor.statuses.has(s))) return false;
  if (actor.statuses.has("reaction")) return false;
  try { if (MidiQOL.hasUsedReaction(actor)) return false; } catch (e) { /* ignore */ }
  return true;
}

function isExempt(moverActor) {
  if (!moverActor) return false;
  if (foundry.utils.getProperty(moverActor, `flags.${MOD}.noProvoke`)) return true;
  if (moverActor.statuses.has("disengage")) return true;
  if (moverActor.effects.some(e => !e.disabled && foundry.utils.getProperty(e, `flags.${MOD}.noProvoke`))) return true;
  if (moverActor.items.some(i => /fly-?by/i.test(i.name))) return true;
  return false;
}


/* Heavy obscurement (e.g. Fog Cloud): regions flagged `flags.opportunity-attack.obscured`.
 * A reactor must be able to SEE the mover, so a straight line between the two that touches such a region blocks it. */
function sightBlocked(rDoc, moverDoc, fromPos) {
  const scene = moverDoc.parent;
  const regions = scene.regions.filter(r => foundry.utils.getProperty(r, `flags.${MOD}.obscured`));
  if (!regions.length) return false;
  const gs = scene.grid.size;
  const ctr = (pos, d) => ({ x: pos.x + (d.width * gs) / 2, y: pos.y + (d.height * gs) / 2 });
  const a = ctr(rDoc, rDoc), b = ctr(fromPos, moverDoc);
  const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (gs / 4)));
  for (let i = 0; i <= steps; i++) {
    const pt = { x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps };
    for (const r of regions) {
      try { if ((r.object?.testPoint ? r.object.testPoint(pt, moverDoc.elevation) : r.testPoint(pt, moverDoc.elevation))) return true; } catch (e) { /* ignore */ }
    }
  }
  return false;
}


/* Invisible mover: the reactor can't see it unless it has truesight/blindsight (in range) or a see-invisible effect. */
function cantSeeInvisible(rActor, rDoc, moverDoc, fromPos) {
  if (!moverDoc.actor?.statuses.has("invisible")) return false;
  const r = rActor.system?.attributes?.senses?.ranges ?? {};
  const gs = moverDoc.parent.grid;
  const dist = rectDistance(rectOf(fromPos, moverDoc), rectOf(rDoc, rDoc));
  const reach = Math.max(r.truesight ?? 0, r.blindsight ?? 0);
  if (reach >= dist) return false;
  if (foundry.utils.getProperty(rActor, `flags.${MOD}.seeInvisible`)) return false;
  return true;
}

/* ---------- main check ---------- */

async function checkMovement(moverDoc, mv) {
  if (moverDoc.hidden) return;
  const moverActor = moverDoc.actor;
  if (isExempt(moverActor)) return;
  if (!game.combat.combatants.some(c => c.tokenId === moverDoc.id)) return;

  // Path: origin -> each passed waypoint
  const path = [mv.origin, ...(mv.passed?.waypoints ?? [])];
  if (path.length < 2) path.push(mv.destination);

  for (const c of game.combat.combatants) {
    if (c.tokenId === moverDoc.id || c.defeated) continue;
    const rDoc = c.token;
    if (!rDoc || rDoc.hidden || rDoc.parent !== moverDoc.parent) continue;
    if (rDoc.disposition * moverDoc.disposition !== -1) continue;
    const rActor = rDoc.actor;
    if (!canReact(rActor)) continue;
    if (rActor.statuses.has("blinded")) continue;
    if (sightBlocked(rDoc, moverDoc, path[0])) continue;
    if (cantSeeInvisible(rActor, rDoc, moverDoc, path[0])) continue;
    const options = meleeOptions(rActor);
    if (!options.length) continue;
    const rRect = rectOf(rDoc, rDoc);
    const maxReach = Math.max(...options.map(o => o.reach));
    const inReach = pos => rectDistance(rectOf(pos, moverDoc), rRect) <= maxReach;

    let provoked = false;
    for (let i = 0; i < path.length - 1; i++) {
      if (inReach(path[i]) && !inReach(path[i + 1])) { provoked = true; break; }
    }
    if (!provoked) continue;

    const usable = options.filter(o => {
      const r = rectOf(path[0], moverDoc);
      return rectDistance(r, rRect) <= o.reach;
    });
    if (!usable.length) continue;

    // Who answers: an active non-GM owner, else the GM.
    const owner = game.users.find(u => u.active && !u.isGM && rActor.testUserPermission(u, "OWNER"));
    const userId = owner?.id ?? game.user.id;
    if (userId === game.user.id) promptReaction(rDoc.uuid, moverDoc.uuid, usable);
    else ensureSocket()?.executeAsUser("prompt", userId, rDoc.uuid, moverDoc.uuid, usable);
  }
}

/* ---------- prompt (runs on the responding user's client) ---------- */

async function promptReaction(reactorUuid, moverUuid, options) {
  const rDoc = await fromUuid(reactorUuid);
  const mDoc = await fromUuid(moverUuid);
  if (!rDoc?.actor || !mDoc) return;
  if (!canReact(rDoc.actor)) return;

  const buttons = options.map((o, i) => ({
    action: String(i),
    label: `${o.name} (${o.reach} ft)`,
    icon: "fa-solid fa-sword",
    default: i === 0
  }));
  buttons.push({ action: "skip", label: game.i18n.localize("OPPATK.Skip"), icon: "fa-solid fa-xmark" });

  const choice = await foundry.applications.api.DialogV2.wait({
    window: { title: game.i18n.localize("OPPATK.Title") },
    content: `<p>${game.i18n.format("OPPATK.Prompt", { mover: mDoc.name, reactor: rDoc.name })}</p>`,
    buttons,
    rejectClose: false,
    modal: false
  });
  if (choice == null || choice === "skip") return;
  const opt = options[Number(choice)];
  if (!opt) return;

  const item = await fromUuid(opt.itemUuid);
  const activity = item?.system.activities?.get(opt.activityId);
  if (!activity) return;
  if (!canReact(rDoc.actor)) return;

  // Select reactor, target mover, attack, then spend the reaction.
  rDoc.object?.control({ releaseOthers: true });
  mDoc.object?.setTarget(true, { releaseOthers: true, groupSelection: false });
  // The target has already left the reach (the token moved before this prompt), so Midi's range
  // check would reject the attack. Switch it off for the duration of this one attack.
  const rules = MidiQOL.configSettings().optionalRules;
  const prevRange = rules?.checkRange;
  if (rules) rules.checkRange = "none";
  try {
    await MidiQOL.completeActivityUse(activity, { midiOptions: { targetUuids: [moverUuid] } }, {}, {});
  } finally {
    if (rules) rules.checkRange = prevRange;
    // Mark the reaction as spent after the attack so Midi's own reaction check does not block it.
    try { await MidiQOL.setReactionUsed(rDoc.actor); } catch (e) { console.warn(MOD, e); }
  }
}

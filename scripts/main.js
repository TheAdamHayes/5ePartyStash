import { MODULE_ID, SETTINGS, STASH_NAME } from "./constants.js";
import { applyPatches, registerHooks } from "./patches.js";
import { registerUI } from "./ui.js";
import { StashOverview, openEditor, refreshOverviews } from "./apps.js";
import {
  createStash, ensureStash, getDefaultStash, getStash, getStashes, giveBag, openStash, transferToStash
} from "./stash.js";

Hooks.once("init", () => {
  // Only GMs can change world settings, so only a GM can flip this.
  game.settings.register(MODULE_ID, SETTINGS.PLAYERS_MANAGE, {
    name: "Players can create and edit stashes",
    hint: "When ticked, players can make new party stashes and change stash names, icons, colours and tabs (using the wrench in a stash's window). When unticked, only GMs can. Everyone can always use the stashes and sort items between tabs.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => {
      refreshOverviews();
      // Redraw open stash windows so the wrench appears or disappears.
      for ( const s of getStashes() ) if ( s.sheet?.rendered ) s.sheet.render();
    }
  });

  game.settings.registerMenu(MODULE_ID, SETTINGS.OVERVIEW, {
    name: "Party stash overview",
    label: "Open Stash Overview",
    hint: "See every party stash in this world, who carries each one, and create, edit or delete stashes.",
    icon: "fa-solid fa-boxes-stacked",
    type: StashOverview,
    restricted: true
  });

  applyPatches();
  registerHooks();
  registerUI();
});

Hooks.once("ready", async () => {
  if ( game.system.id !== "dnd5e" ) {
    console.warn(`${MODULE_ID} | This module only works with the D&D 5e system.`);
    return;
  }

  // Only one GM sets things up, even if several are logged in.
  if ( game.user.isGM && (game.users.activeGM?.id === game.user.id) ) await ensureStash();

  // Small API for macros, e.g. game.modules.get("ah-5e-party-stash").api.open("Loot")
  const module = game.modules.get(MODULE_ID);
  if ( module ) module.api = {
    /** Open a stash by name or id (or the main stash if left out). */
    open: nameOrId => openStash(findStash(nameOrId)),
    /** Open the editor for a stash by name or id. */
    edit: nameOrId => openEditor(findStash(nameOrId)),
    /** Make a new stash, e.g. create({ name: "Loot", accent: "#d4a017" }). */
    create: data => createStash(data),
    /** Give a character a bag for a stash. */
    give: (nameOrId, actor) => giveBag(findStash(nameOrId), actor),
    transfer: (item, nameOrId) => transferToStash(item, findStash(nameOrId)),
    stashes: () => getStashes(),
    overview: () => new StashOverview().render({ force: true })
  };
});

function findStash(nameOrId) {
  if ( !nameOrId ) return getDefaultStash();
  const stash = getStash(nameOrId) ?? getStashes().find(s => s.name.toLowerCase() === String(nameOrId).toLowerCase());
  if ( !stash ) ui.notifications.warn(`${STASH_NAME}: no stash called "${nameOrId}".`);
  return stash;
}

import { MODULE_ID, SETTINGS, DEFAULT_ICON, STASH_NAME } from "./constants.js";
import { applyPatches, registerHooks } from "./patches.js";
import { registerUI } from "./ui.js";
import { applyIcon, ensureStash, getStashContainer, openStash, transferToStash } from "./stash.js";

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTINGS.ICON, {
    name: "Stash icon",
    hint: "Picture used for the Shared Party Stash bag. The default is a red reinforced chest from Foundry's built-in icons, so it never looks like an ordinary bag.",
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_ICON,
    filePicker: "image",
    onChange: () => applyIcon()
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
  if ( game.user.isGM && (game.users.activeGM?.id === game.user.id) ) {
    try {
      await ensureStash();
    } catch ( err ) {
      console.error(`${MODULE_ID} | Could not set up the ${STASH_NAME}.`, err);
      ui.notifications.error(`${STASH_NAME}: setup failed. See the browser console (F12) for details.`);
    }
  }

  // Small API for macros: game.modules.get("ah-5e-party-stash").api.open()
  const module = game.modules.get(MODULE_ID);
  if ( module ) module.api = { open: openStash, transfer: transferToStash, getStash: getStashContainer };
});

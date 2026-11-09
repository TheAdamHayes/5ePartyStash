/** Must match "id" in module.json. Used for flags and settings. */
export const MODULE_ID = "ah-5e-party-stash";

export const STASH_NAME = "Party Stash";

/** Name of the folder in the Items sidebar that holds one item per stash. */
export const FOLDER_NAME = "Party Stashes";

/** A built-in Foundry core icon (shipped with Foundry, not generated). Used for the first stash. */
export const DEFAULT_ICON = "icons/containers/chest/chest-reinforced-steel-red.webp";

/**
 * Bag and chest icons the stash editor offers. All of them ship with Foundry itself
 * (the D&D 5e system's own items use these exact paths), none are AI generated.
 */
export const ICON_POOL = Object.freeze([
  "icons/containers/chest/chest-reinforced-steel-red.webp",
  "icons/containers/chest/chest-reinforced-steel-tan.webp",
  "icons/containers/chest/chest-reinforced-steel-walnut-brown.webp",
  "icons/containers/chest/chest-reinforced-box-brown.webp",
  "icons/containers/chest/chest-elm-steel-brown.webp",
  "icons/containers/chest/chest-simple-box-brown.webp",
  "icons/containers/chest/chest-simple-box-gold-brown.webp",
  "icons/containers/boxes/crate-heavy-yellow.webp",
  "icons/containers/boxes/crate-wooden-grey.webp",
  "icons/containers/barrels/barrel-oak-banded-tan.webp",
  "icons/containers/barrels/barrel-walnut-steel-brown.webp",
  "icons/containers/misc/basket-handle-woven-gold.webp",
  "icons/containers/misc/basket-handle-woven-yellow.webp",
  "icons/containers/bags/case-leather-tan.webp",
  "icons/containers/bags/case-scroll-leather-tan.webp",
  "icons/containers/bags/case-simple-brown.webp",
  "icons/containers/bags/coinpouch-leather-grey.webp",
  "icons/containers/bags/coinpouch-simple-leather-brown.webp",
  "icons/containers/bags/coinpouch-simple-leather-silver-brown.webp",
  "icons/containers/bags/coinpouch-simple-leather-tan.webp",
  "icons/containers/bags/pack-canvas-white-brown.webp",
  "icons/containers/bags/pack-engraved-leather-blue.webp",
  "icons/containers/bags/pack-engraved-leather-tan.webp",
  "icons/containers/bags/pack-leather-black-brown.webp",
  "icons/containers/bags/pack-leather-brown.webp",
  "icons/containers/bags/pack-leather-embossed-brown.webp",
  "icons/containers/bags/pack-leather-gold-brown.webp",
  "icons/containers/bags/pack-leather-gold-pink.webp",
  "icons/containers/bags/pack-leather-strapped-tan.webp",
  "icons/containers/bags/pack-leather-white-tan.webp",
  "icons/containers/bags/pack-simple-leather-fur-tan.webp",
  "icons/containers/bags/pack-simple-stitched-leather-tan.webp",
  "icons/containers/bags/pouch-cloth-tan.webp",
  "icons/containers/bags/pouch-gold-green.webp",
  "icons/containers/bags/pouch-gold-grey.webp",
  "icons/containers/bags/pouch-leather-brown-green.webp",
  "icons/containers/bags/pouch-leather-gold-tan.webp",
  "icons/containers/bags/pouch-leather-green.webp",
  "icons/containers/bags/pouch-leather-pink.webp",
  "icons/containers/bags/pouch-leather-silver-brown.webp",
  "icons/containers/bags/pouch-rounded-leather-gold-tan.webp",
  "icons/containers/bags/sack-cloth-green-blue.webp",
  "icons/containers/bags/sack-cloth-orange.webp",
  "icons/containers/bags/sack-leather-brown-green.webp",
  "icons/containers/bags/sack-leather-red.webp",
  "icons/containers/bags/sack-simple-leather-tan.webp",
  "icons/containers/bags/sack-twisted-leather-red.webp",
  "icons/containers/bags/sack-twisted-skull-purple.webp"
]);

/** How many icons the editor shows at once. */
export const ICON_CHOICES = 10;

export const SETTINGS = Object.freeze({
  PLAYERS_MANAGE: "playersManage",
  OVERVIEW: "overview"
});

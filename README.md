# AH 5E Party Stash

A shared party inventory for **Foundry VTT v14** and the **D&D 5e** system (5.3 or newer, tested against the 6.0 code).

Every world gets one shared stash. Players carry a weightless **Shared Party Stash** bag that opens the stash in its own window, using the normal dnd5e bag screen. Anything put in the stash can be taken out by any player in that world. Stashes are never shared between worlds.

## Install

In Foundry: **Add-on Modules > Install Module**, paste this into **Manifest URL**:

```
https://github.com/TheAdamHayes/5ePartyStash/releases/latest/download/module.json
```

Enable the module in your world, then **log in as the GM once**. The module sets itself up:

- An actor called **Party Stash** (a group actor) that really holds the items. All players own it so they can use the stash.
- A bag on that actor, also called **Party Stash**, which is the stash itself.
- An item in the **Items** sidebar called **Shared Party Stash**, which players drag into their inventory.

## Using it

1. Drag **Shared Party Stash** from the Items sidebar into a character's inventory.
2. A red chest with a blue **Party** badge appears next to the character's other bag icons, plus a **Party** button. Clicking either opens the shared stash.
3. **Put items in:** drag them into the stash window, or drop them on the Party button or the shared bag icon.
4. **Take items out:** drag them from the stash window into your inventory.

Items always **move** (they're never duplicated). The GM can hold Ctrl or Alt while dragging to copy instead.

- The bag weighs nothing and never counts towards encumbrance.
- There's no limit on how many items the stash holds.
- Removing the bag from your inventory asks you first, and never loses any items. Drag another **Shared Party Stash** in to get access back.
- Only the GM can delete the real stash, and gets a strong warning first. If it's deleted anyway, the items are kept and a new stash bag is made for them.

## Settings

- **Stash icon:** the picture used for the shared bag. The default is Foundry's built-in `icons/containers/chest/chest-reinforced-steel-red.webp`.

## Macro

```js
game.modules.get("ah-5e-party-stash").api.open();
```

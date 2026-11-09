# AH 5E Party Stash

Shared party inventories for **Foundry VTT v14** and the **D&D 5e** system (5.3 or newer, built against 6.1).

Players carry a weightless stash bag that opens a stash shared by everyone in the world, using the normal dnd5e bag window. A world can have as many stashes as you like (e.g. "Loot", "Potions", "Wagon"), each with its own name, icon, accent colour and tabs. Stashes are never shared between worlds.

## Install

In Foundry: **Add-on Modules > Install Module**, paste this into **Manifest URL**:

```
https://github.com/TheAdamHayes/5ePartyStash/releases/latest/download/module.json
```

Enable the module in your world, then **log in as the GM once**. The module sets itself up:

- An actor called **Party Stash** (a group actor) that really holds every stash and its items. All players own it so they can use the stashes without the GM online.
- A first stash, called **Party Stash**.
- A folder in the **Items** sidebar called **Party Stashes**, with one item per stash. Players drag these into their inventory.

## Getting the bags to players

- **Automatically:** with **Give new stashes to every player character** on (the default), a new stash's bag goes straight into the inventory of every character a player owns.
- **From the overview:** in **Stash Overview**, each stash has a **Give to everyone** button (puts its bag in every player character's inventory, skipping anyone who already has it) and a **Take back** button (removes it from everyone; no items are lost).
- **By hand:** drag a stash from the **Party Stashes** folder in the Items sidebar onto a character.

## Using a stash

1. Make sure the character has the stash's bag (see above).
2. Its icon appears next to the character's other bag icons, glowing in the stash's accent colour with its name along the bottom. Click it to open the stash.
3. **Put items in:** drag them into the stash window, or drop them on the stash's bag icon.
4. **Take items out:** drag them from the stash window into your inventory.

Items always **move** (they're never duplicated). The GM can hold Ctrl or Alt while dragging to copy instead.

- Stash bags weigh nothing and never count towards encumbrance.
- There's no limit on how many items a stash holds.
- Removing a stash bag from your inventory asks you first, and never loses any items. Drag it in again from the Items sidebar to get access back.
- If a stash's item in the Items sidebar is deleted, it's put back straight away.

## Tabs

Each stash window has folder-style tabs along the top: **All**, one per tab you've set up, and **Unsorted** (items not on any tab). The open tab is filled with the stash's accent colour and joins the line below it. Each tab shows how many items are on it.

- Click a tab to show only its items.
- Items dropped into the stash while a tab is open go on that tab.
- Drag an item onto a tab to move it there (from the stash, another stash, or a character).

If you're allowed to edit stashes (see Settings), you can also change tabs right there in the stash window:

- **+** adds a new tab and puts you straight into typing its name. Press Enter (or click away) to keep it, Escape to cancel.
- **Double-click** a tab to rename it.
- **Right-click** a tab for **Rename**, **Keywords…**, **Move left**, **Move right** and **Delete tab** (its items move to Unsorted; nothing is lost).

Each tab also has **keywords** (e.g. `sword, axe, bow`). They're saved with the tab, ready for automatic sorting in a future update. Hover over a tab to see them.

## Editing a stash (the wrench)

Click the **wrench** at the top of a stash window (or the **+** at the end of its tabs) to:

- rename the stash
- pick an **accent colour**
- choose an **icon** from 10 built-in Foundry bag and chest icons, or press **Reroll** for 10 more (GMs can also **Browse…** for any image)
- add, rename, reorder and remove tabs, and set each tab's keywords
- **Paste layout…** to set the name and tabs from text, like this:

```
# Bag Name
## Category Name 1
*Keywords, separated, by, commas*

## Category Name 2
*Keywords, separated, by, commas*
```

- **Create new stash**
- **Delete stash** (GM only). You choose whether its items move to another stash or are deleted too. The last stash can't be deleted.

## Settings (GM)

- **Players can create and edit stashes:** when off (the default), only GMs see the wrench, make new stashes, and change stash names, icons, colours and tabs. Everyone can always use the stashes and sort items between tabs. If a player makes a stash while no GM is online, its bag goes into their own assigned character; everyone else gets it once a GM gives it out.
- **Give new stashes to every player character:** on by default. A "player character" is any character a player owns, plus each player's assigned character.
- **Party stash overview:** a list of every stash with its item count, tabs and who carries it. From here you can give a stash to everyone or take it back, open, edit, delete or create stashes, flip both settings above, and **Repair & re-sync** (rebuilds missing sidebar items and updates every carried bag).

## Macros

```js
const api = game.modules.get("ah-5e-party-stash").api;
api.open("Loot");                                  // open a stash by name (or leave empty for the main one)
api.edit("Loot");                                  // open its editor
api.create({ name: "Wagon", accent: "#d4a017" });  // make a new stash
api.give("Loot", game.actors.getName("Hero"));     // give a character that stash's bag
api.overview();                                    // open the overview
```

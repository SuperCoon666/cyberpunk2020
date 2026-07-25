# cyberpunk2020 (for Foundry VTT)

First and foremost, huge thanks to the original author — **OctarineSourcerer**. Because of people like them we all get to enjoy our favourite games.
This system is built on OctarineSourcerer’s work, refining and expanding the available features. In version **1.0.0** I fixed the bugs I could track down and added new functionality, including **netrunning**. I’m planning to keep improving this system because I’m a long-time Cyberpunk 2020 fan.

Also, [join](https://discord.gg/xPQcDZYDMU) our **Discord** server.

R. Talsorian Games’ [Cyberpunk 2020](https://talsorianstore.com/products/cyberpunk-2020) system, now for Foundry VTT.

![image](https://github.com/user-attachments/assets/9e3ef043-ebaa-479a-954c-50ed04b20a6f)

![image](https://user-images.githubusercontent.com/6842867/115111021-26bfe680-9f76-11eb-93ee-7cf42d44190f.png)


## Current features

* **Character sheet** with stats, damage tracking, gear, combat tab, searchable skills and cyberware.
* **Consistent UI** inspired by the Core Rulebook, with a strong focus on usability.
* **Skills as items**, sortable by name or governing stat; full chipped/unchipped tracking, IP, roll-able, etc.
* **Proportional stopping power & encumbrance** for armour.
* **Ranged combat**: single shots, three-round burst, and autofire.
* **Quick modifier picker** when making ranged attacks.
* The **beginning of the melee system**: cyberlimb damage bonuses and martial-arts bonuses are already in.
* **Solo professional ability** is factored into initiative and awareness rolls.
* **Ammo tracking & quick reloads** directly from chat.
* **Netrunning**: major core functionality — deck builder with configuration, purchased program list, active program panel, automatic RAM usage & total cost, and one-click *Interface* rolls from the Netrunning tab.
* **Full Russian localisation**.
* **New icons** styled to match the rest of the system.
* Active bonuses from cyberware.
* An expanded melee-weapons library.

## Planned features

* Target selection and automatic damage application.
* Shopping workflow with automatic money deduction.
* Automatic generation of cinematic finishing moves.
* **Mech sheet**.

All rights to Cyberpunk 2020 belong to R. Talsorian Games. Under their [homebrew content policy](https://rtalsoriangames.com/homebrew-content-policy/), any compendium produced with this system will include only the statistical summaries of items (equivalent to the weapon-table rows) and no descriptive text. There will be no stat blocks for monsters, NPCs, or hazards.

## How to build

There is no build step. `css/cyberpunk2020.css` is the stylesheet `system.json` loads and the source of truth for styling — edit it directly. The SCSS sources it was originally compiled from had drifted far behind the committed CSS and have been removed.

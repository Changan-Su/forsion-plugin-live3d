---
name: Live3D model import
description: Use when the user wants to import, show, identify, convert or fix a 3D avatar or character model on the Agent Desk with the Live3D plugin, including when they only give a file path (.vrm / .glb / .gltf / .fbx / .obj / .pmx / .pmd, an MMD or VRoid model pack, or a .zip / .7z / .rar archive) and ask whether it can be imported. Also covers giving a specific agent its own avatar (binding) and fixing how an avatar stands or moves when the user says it looks stiff, weird, or that its arms or hands are in the wrong place. Finds the Live3D work folder, copies or extracts the files into models/<slug>/, maps the model's animations and expressions to agent states, and writes models/<slug>/live3d.json.
version: 0.1.0
author: Forsion
category: Forsion
---

# Live3D model import

Live3D shows a 3D avatar on the Agent Desk (the card to the right of the chat) and makes it react to what the agent is doing. Each model lives in its own folder with a profile file, `live3d.json`, that tells the plugin which file to load and how to react in each state. Your job is to write that profile — and, when the model is not in a format the plugin can load, to convert it first. Any agent can do this, not only the bundled Live3D Importer.

## Where the files are

Every model lives in `models/<slug>/` inside the Live3D **work folder**. By default that is the folder `Live3D` at the root of the user's notes vault, and its `README.md` starts with the line `# Live3D`. Find it first:

1. **The message comes from the Live3D plugin.** It says the model folder is relative to the current working directory (for example `models/alice/`) and names this skill. When the plugin opened the chat itself, your cwd is the work folder, but the same text is also pasted by hand into other chats. So check first: `list_dir models/<slug>` must show the files the message lists. If it does, use exactly the paths it gives. If it does not, use the message's "Absolute path" line as in case 2, or, if it has none, join its "Path inside the vault" to the vault path as in case 3.
2. **The message gives an absolute model folder** ending in `/models/<slug>`. The work folder is the folder that contains `models/`.
3. **Anything else** (the user just asked you, perhaps with a path to a file or an archive). Take the vault's absolute path from your system prompt: the notes / Amadeus section, or the list of additional working folders. If a path you try does not exist, try the other ones before searching wider. Then:
   - `read_file "<vault>/Live3D/README.md"`: a first line of `# Live3D` confirms the work folder is `<vault>/Live3D`.
   - If that file does not exist, the user may have renamed the folder. Search once: `find "<vault>" -maxdepth 3 -name README.md -exec grep -l -x "# Live3D" {} +`.
   - If nothing turns up, use `<vault>/Live3D` (the default): create it with `mkdir -p "<vault>/Live3D/models"` and tell the user you assumed the default folder.
   - If your system prompt names no vault at all, ask the user: Settings → Plugins → Live3D shows the absolute path of the **models folder** (`…/<work folder>/models`); the work folder is its parent, so drop the last `/models`.

Rules that apply everywhere:

- **Never guess vault or home paths** such as `~/Documents/<vault>`. Cloud vaults live in hidden folders (`~/.forsion/Amadeus Cloud/…`, `~/.forsion-dev/Amadeus Cloud/…`), so a guessed path is wrong without any error.
- **Use absolute paths without `~`** for files outside your cwd. `read_file`, `list_dir` and `write_file` do not expand `~`: they would look for a folder named `~` inside your cwd. Expand it yourself (`echo $HOME` in `run_bash` prints the home folder).
- `search_files` and `glob_files` only search your cwd. To look anywhere else, use `list_dir` or `run_bash` with absolute paths.
- Commands in this skill write paths relative to the work folder (`models/<slug>/…`). When your cwd is not the work folder, start the same command with `cd "<work folder>" && …`. Otherwise a bare `archive.zip` or `-d .` reads or writes somewhere else.
- **Windows:** `run_bash` runs `cmd.exe`, not a POSIX shell. Use `cd /d "<work folder>" && …` (it also switches drives), `mkdir` without `-p` (it creates parents), `dir` instead of `ls`, `robocopy "<source folder>" "models\<slug>" /E /XC /XN /XO` instead of `cp -Rn`, `copy` for a single file, and `%USERPROFILE%` instead of `$HOME`. `tar -xkf` works as written: Windows ships bsdtar.
- Write only inside one `models/<slug>/` folder. Never delete, move or overwrite the user's original files, wherever they are; converted files get new names.
- Never edit Live3D's own settings or data files (such as `plugins-data/live3d.json`): the plugin keeps them in memory and overwrites them.

## Step 0: bring the user's files in (only when the model folder does not exist yet)

When the plugin opened the chat, it has already copied the files: skip to Step 1. When the user gave you a file, a folder or an archive, create the model folder yourself:

1. **Slug.** Start from the file name without its extension, or from the folder name. Lower-case it, keep ASCII letters and digits, turn every other run of characters into one `-`, drop leading and trailing `-`, and cut it to 48 characters. If nothing is left (a name in Chinese or Japanese only, for example), use `model`. A slug never starts with `.`.
2. **No collisions.** `ls "<work folder>/models"` first (if `models/` does not exist yet, create it with `mkdir -p "<work folder>/models"`). The slug must differ from every existing folder **ignoring case** (`Alice` and `alice` are the same folder on macOS and Windows). If it is taken, add `-2`, `-3`, … until it is free.
3. **Create and fill it:**
   - An archive: extract it straight into the new folder: `cd "<work folder>" && mkdir "models/<slug>" && tar -xkf "<absolute path to the archive>.zip" -C "models/<slug>/"`. Read **Archives** in Step 3 first: it explains why `tar` and not `unzip`.
   - A single file: `cd "<work folder>" && mkdir "models/<slug>" && cp -n "<absolute path to the model>.vrm" "models/<slug>/"`.
   - A folder: copy its **contents**, so the model does not end up one level deeper: `cd "<work folder>" && mkdir "models/<slug>" && cp -Rn "<absolute path to the folder>/." "models/<slug>/"`. Copy, never move. Keep a model's texture folders next to it.
   - `mkdir` without `-p` is deliberate: it fails if the folder already exists, instead of mixing two models.
4. There is no `analysis.json` or `preview.png` in a folder you created: inspect the files yourself (the end of Step 1).

Folder layout the plugin expects:

```
models/<slug>/
  live3d.json     the profile you write
  analysis.json   what the plugin found when it tried to load the model (may be missing)
  preview.png     a front-view thumbnail the plugin rendered (may be missing)
  <model files>   .vrm / .glb / .gltf / .fbx / .obj / .pmx / .pmd, textures, .bin, motion files
```

## Step 1: read what the plugin already found

1. `read_file models/<slug>/analysis.json` if it exists. Fields:
   - `format`: `vrm` | `gltf` | `glb` | `fbx` | `obj`; `file`: the model file relative to the folder.
   - `vrm`: `{ specVersion: "0" | "1", title, expressions: [...], humanBones: [...] }` — only for VRM.
   - `clips`: `[{ name, duration, source }]` — every animation clip the plugin could play, with its **exact** name. `source` is the file it came from, relative to the folder.
   - `morphs`: morph target (blend shape) names on non-VRM models.
   - `bones`: `{ count, head, neck, rig }`, where `rig` is `vrm` | `mixamo` | `vroid` | `mmd` | `unknown`.
   - `meshes`, `triangles`, `textures`, `size` (bounding box `[x, y, z]` in the file's units), `upAxisGuess` (`y` | `z`).
   - `warnings`: English diagnostics (missing textures, skipped clips, compression the plugin cannot read).
   - `suggested`: a `states` object the plugin guessed from the names. Start from it.
2. `view_image models/<slug>/preview.png` if it exists: check the model faces the camera, is upright and has textures.
3. No `analysis.json` in a folder the plugin created means the plugin could not load the file directly. The user's first message then usually has an "Error when the plugin tried to load it directly" line with the exact reason (Draco compression, KTX2 textures, a parse error, a missing texture…). Read it, then go to **Step 3** and convert first.

To peek inside a binary `.glb` / `.vrm` without analysis.json (read-only), use `run_bash` with node if it is installed:

```sh
node -e 'const b=require("fs").readFileSync(process.argv[1]);const n=b.readUInt32LE(12);const j=JSON.parse(b.subarray(20,20+n));const e=j.extensions||{};console.log(JSON.stringify({animations:(j.animations||[]).map(a=>a.name),extensionsUsed:j.extensionsUsed||[],extensionsRequired:j.extensionsRequired||[],vrm0:((e.VRM||{}).blendShapeMaster||{}).blendShapeGroups?.map(g=>g.presetName||g.name),vrm1:Object.keys(((e.VRMC_vrm||{}).expressions||{}).preset||{}).concat(Object.keys(((e.VRMC_vrm||{}).expressions||{}).custom||{}))},null,1))' "models/<slug>/avatar.vrm"
```

Without node, `strings` and `grep` on the file still show clip and morph names. A `.gltf` file is plain JSON: `read_file` it.

## Step 2: write live3d.json (schema v1)

The plugin validates the file strictly. Use exactly these field names — an unknown field is ignored with a warning, and a wrong value makes the whole profile invalid.

| Field | Type / allowed values | Default | Meaning |
|---|---|---|---|
| `live3d` | must be the number `1` | required | Profile version. |
| `name` | string | model file name | Display name in the library. |
| `model` | relative path ending in `.vrm`, `.glb`, `.gltf`, `.fbx`, `.obj`, `.pmx` or `.pmd` | required | The model to show. |
| `motions` | array of relative paths ending in `.vrma`, `.fbx`, `.glb` or `.gltf` | `[]` | Extra animation files whose clips become playable. |
| `transform` | object, see below | identity | Placement fixes. |
| `transform.scale` | number, above 0 and at most 100 | `1` | Multiplies the size after the plugin normalizes the model to about 1.6 units tall. |
| `transform.rotateY` | number, degrees | `0` | Turn around the vertical axis. |
| `transform.offsetY` | number from -10 to 10 | `0` | Vertical shift after normalization (units ≈ metres). |
| `transform.upAxis` | `"y"` or `"z"` | `"y"` | Use `"z"` for a model lying on its back (common for OBJ). |
| `framing` | `"bust"`, `"full"` or `"face"` | `"bust"` | Camera framing: head to waist, whole body, or a close-up. |
| `agents` | array of agent slugs | `[]` | Agents that use this companion; see **Binding**. |
| `states` | object keyed by phase name | `{}` | Per-state reactions, see below. |
| `pose` | object, see **Idle pose** | defaults | How the avatar stands when no clip is playing. |

Path rules for `model` and `motions`: relative to the folder that holds `live3d.json` (so usually just a file name such as `alice.vrm` or `motions/wave.vrma`). No absolute paths, no `~`, no URLs, no `..`. Live2D files are rejected.

`states` keys must be phase names — any other key makes the profile invalid:

| Phase | When | Built-in behaviour without a mapping |
|---|---|---|
| `idle` | nothing running | loops the `idle` clip; eyes follow the pointer |
| `thinking` | running, reasoning, no text yet | looks up, head tilt |
| `speaking` | streaming the answer | nods; the mouth follows the text stream |
| `tool` | a tool is running | looks down, small nods |
| `waiting` | needs the user (approval or a question) | bounces, looks at the camera |
| `error` | the run just failed | droops |
| `done` | the run just finished | small hop, looks at the camera |

Each phase value is an object with any of these fields (or `null`, which is the same as leaving the phase out):

| Field | Type | Meaning |
|---|---|---|
| `clip` | string, or `null` | Exact clip name from `analysis.json` `clips[].name`. `null` = explicitly play no clip in this state. Omitted = keep looping the `idle` clip. |
| `expression` | non-empty string | VRM expression name, or a morph name on non-VRM models. |
| `weight` | number from 0 to 1 | Expression strength (default depends on the phase, 0.7 when unknown). |
| `mouth` | non-empty string | Only used in `speaking`: the expression or morph that opens the mouth. |
| `once` | `true` or `false` | Play the clip once, then return to the `idle` clip. |

Example:

```json
{
  "live3d": 1,
  "name": "Alice",
  "model": "alice.vrm",
  "motions": ["motions/wave.vrma"],
  "agents": ["xyra"],
  "transform": { "scale": 1, "rotateY": 0, "offsetY": 0 },
  "framing": "bust",
  "pose": { "armSpread": 0.36, "armForward": 0.2, "elbow": 0.26, "liveliness": 1 },
  "states": {
    "idle": { "clip": "Idle" },
    "thinking": { "expression": "relaxed", "weight": 0.35 },
    "speaking": { "mouth": "aa" },
    "tool": { "clip": "Typing" },
    "waiting": { "clip": "wave", "once": true, "expression": "surprised", "weight": 0.5 },
    "error": { "expression": "sad", "weight": 0.7 },
    "done": { "clip": "Cheer", "once": true, "expression": "happy", "weight": 0.8 }
  }
}
```

## Binding: giving one agent its own avatar

Each chat shows the companion bound to that chat's agent; chats whose agent is not bound to anything show the **default** companion picked in the Live3D settings. The binding lives in `agents` in the model's own `live3d.json`, so you can set it with `write_file` — nothing else has to change.

- The user says "use this model for <agent>", "give <agent> its own avatar", "让 xyra 用这个形象" → add that agent's **slug** to `agents` in that model's `live3d.json`.
- A slug is lower-case letters, digits and hyphens (`xyra`, `code-reviewer`). It is the agent's folder name, not its display name. Get it right: run `list_dir` on the agents folder, or ask the user. An unknown slug is not an error anywhere — the binding simply never takes effect, which is impossible for the user to debug.
- One model can serve several agents (`"agents": ["xyra", "muse"]`). If two models claim the same agent, the one whose **folder name** sorts first alphabetically wins, so remove the slug from the other model rather than leaving a silent tie.
- To unbind, remove the slug. An empty `agents` (`[]`) means the model is only used when it is the default companion.
- Whoever changes a binding should say which agents now use which model.

## Idle pose: how the avatar stands

`pose` only matters when no animation clip is playing — which is every state for MMD, VRoid and other models with no clips. Four numbers, all `0`–`1` except `liveliness` (`0`–`2`):

| Field | Default | Raise it when | Lower it when |
|---|---|---|---|
| `armSpread` | `0.36` | the hands sink into a wide skirt, armour or a coat | the arms look spread out like wings on a slim character |
| `armForward` | `0.2` | the arms clip into the hips or a bustle from the side | the arms hang in front of the body instead of beside it |
| `elbow` | `0.26` | the arms look like straight sticks | the forearms point at the stomach |
| `liveliness` | `1` | the avatar looks frozen | the swaying is distracting (`0` = stands perfectly still) |

When the user says the avatar looks stiff, weird, like a mannequin, or that its hands are inside its clothes:

1. **First find out whether a clip is driving the arms, or you will change numbers that cannot do anything.** Read the model's `states` and `analysis.json`: wherever a clip plays, the clip wins over `pose` on every bone it animates, and the picture will not move no matter what you set. Models with no clips at all (MMD, most VRoid exports — `clips` is empty) are the normal case for `pose`. If a clip *is* playing in the state the user is complaining about and it is the clip that looks wrong, set that state's `clip` to `null` instead: the avatar then falls back to the procedural pose, and `pose` takes effect. Say which of the two you did.
2. Look before you change anything: `desk_screenshot` (see **Tools**). Decide from the image which of the four numbers is wrong — the table above maps what you see to one field.
3. Change **one** number by about `0.1`, write the file, then take another screenshot. The Desk reloads the pose the moment the file is saved and the model does not reload, so this is quick.
4. Stop as soon as it looks right, and tell the user which number you changed and what it does, so they can nudge it themselves. They can also drag the same four sliders under "Idle pose" / 「待机姿势」 in the model library.
5. If two screenshots in a row look identical after you changed a number, do not keep turning knobs: either a clip is still driving those bones (step 1), or the arm bones were not recognized at all (the T-pose note under **Tools**). Say which one you think it is and stop.

Do not rewrite anything else while you are here. Tuning the pose is not an invitation to re-map clips, change `framing` or rename the model.

## Mapping guidance

- **Clips.** Match clip names in any language to phases by meaning, then copy the name **exactly** as it appears in `clips[].name` (case and spaces matter): idle / 待机 / 待機 / breathing → `idle`; think / 思考 / 考える → `thinking`; talk / speak / 说话 / 話す → `speaking`; typing / keyboard / work / 打字 → `tool`; wave / greet / 挥手 / 手を振る → `waiting`; sad / cry / no / 伤心 → `error`; cheer / victory / dance / clap / 庆祝 → `done`. Never map T-pose or bind-pose clips.
- **`once`.** Set `once: true` for clips in `waiting` and `done`, and for one-shot `error` clips (head shake, fall). Leave looping clips (idle, talk, typing) without `once`.
- **Expressions (VRM).** VRM 1.0 presets: `happy`, `angry`, `sad`, `relaxed`, `surprised`, `neutral`, `aa`, `ih`, `ou`, `ee`, `oh`, `blink`. VRM 0.x models may list `joy`, `sorrow`, `fun`, `angry` instead; the plugin maps those synonyms, but prefer names that appear in `vrm.expressions`.
- **Expressions (non-VRM).** Use morph names from `morphs` (for example ARKit `mouthSmile_L`, VRoid `Fcl_ALL_Joy`, MMD `笑い`). If there are no suitable morphs, leave `expression` out.
- **Mouth.** VRM: `"aa"`. Non-VRM: the first of `jawOpen`, `vrc.v_aa`, `Fcl_MTH_A`, `あ`, `mouthOpen` that exists in `morphs`. No mouth morph → leave `mouth` out; the avatar still nods while speaking.
- **Framing.** `bust` for humanoid avatars (the card is portrait), `face` for a head-only close-up, `full` for small creatures, robots, props and anything that is not a humanoid.
- **Transform.** The plugin already normalizes size and turns models that were exported facing backwards. Only set `rotateY` (usually `180`) if `preview.png` still shows the back, `upAxis: "z"` if the preview shows the model lying down (or `upAxisGuess` is `z`), and `offsetY` / `scale` only for visible framing problems.
- Leave a phase out rather than inventing a mapping. Never invent clip, expression or morph names.

## Step 3: format recipes

Every command below spells paths as `models/<slug>/…`, relative to the **work folder**, not the model folder. Run it from the work folder: when your cwd is somewhere else, prefix it with `cd "<work folder>" && …` in the same command. A bare `archive.zip` or `-d .` would read or write the wrong folder and can clobber the work folder's `README.md`.

Converted and extracted results are always **new** files or folders: never use overwrite flags (`unzip -o`, `cp -f`, `7z -y`/`-aoa`), and pick an output name that does not exist yet (check with `ls` first). Then point `model` (or `motions`) at the new file.

- **`.vrm`, `.glb`, `.gltf`, `.fbx`, `.obj`, `.pmx`, `.pmd`** load directly: just write `live3d.json`.
- **Archives** (`.zip`, `.7z`, `.rar`): list first (`tar -tf "models/<slug>/archive.zip"`), then extract into a **new** subfolder that does not exist yet, never over existing files. Prefer `mkdir "models/<slug>/extracted" && tar -xkf "models/<slug>/archive.zip" -C "models/<slug>/extracted"` (`-k` = never overwrite): `tar` (bsdtar, built into macOS and Windows) reads the Unicode file names that Chinese and Japanese model packs store beside their GBK / Shift-JIS names, while `unzip` and `ditto` turn them into `���` or `‹ÁÃÿ`, and then the model's texture references no longer match. Only if `tar` is missing: `unzip -n -q "models/<slug>/archive.zip" -d "models/<slug>/extracted"` (`-n` = never overwrite), and check the names with `ls`; or `7z x "models/<slug>/archive.7z" -o"models/<slug>/extracted" -aos` if 7-Zip is installed (`-aos` = skip existing files; 7-Zip also opens `.rar`). Then look for the model file inside `extracted/`, point `model` at it (for example `extracted/avatar.vrm`) and continue from Step 1 (there is no analysis.json for the extracted file, so inspect it yourself).
- **glTF with external files**: keep the folder structure exactly; every `uri` in the `.gltf` JSON must resolve inside the folder. `model` points at the `.gltf`.
- **FBX with textures**: FBX files often reference textures by the author's absolute path. The plugin looks for the file name inside the model folder, so copying the textures next to the FBX is enough: `cp -n "models/<slug>/textures/skin.png" "models/<slug>/"` (`-n` = never overwrite).
- **References to the internet**: the plugin never downloads anything. A `.gltf` whose `uri` is an `http(s)://` URL is refused; download nothing yourself either — ask the user for the files and put them in the model folder with relative paths.
- **Mixamo motion FBX** (animation only, "Without Skin"): add it to `motions`. Its clip is named after the file (the Mixamo name `mixamo.com` is replaced), for example `Samba Dancing.fbx` → clip `Samba Dancing`. It only plays on a model with the same skeleton (a Mixamo-rigged model); retargeting onto VRM is not supported.
- **`.vrma`** (VRM Animation): add it to `motions`; the clip is named after the file without `.vrma` unless the file names its animation. Works on VRM models.
- **OBJ**: static, no clips or expressions. Keep the `.mtl` and textures beside it, use `framing: "full"`, and `upAxis: "z"` if it lies down.
- **Draco-compressed glTF/GLB** (the load error in the user's first message says so, or the node one-liner above lists `KHR_draco_mesh_compression` in `extensionsUsed`): if `npx` is available, `npx -y @gltf-transform/cli meshopt "models/<slug>/input.glb" "models/<slug>/input-meshopt.glb"` rewrites the Draco geometry as meshopt, which the plugin reads. Run `npx -y @gltf-transform/cli --help` first if unsure. **Never run gltf-transform on a `.vrm`** — it drops the VRM extensions and the avatar loses its humanoid rig and expressions.
- **KTX2 / Basis textures** (`KHR_texture_basisu`): there is no reliable way to decode them back to PNG here, and the plugin tells the user so. Do not try; ask the user to re-export the model from the original app with ordinary PNG / JPEG / WebP textures.
- **PMX / PMD (MMD)**: loads directly, no conversion. Point `model` at the `.pmx` and leave its texture folders (`tex/`, `spa/`, toon `.bmp` files) where they are: the PMX refers to them by relative path. A pack often holds several `.pmx` files, where the character is usually the largest one and small ones are props (weapons, books, cups). Pick the character, not a prop. The rig is `mmd`. Typical morphs are `あ` (mouth), `まばたき` (blink), `笑い` / `にこり` (smile), `びっくり` (surprised), `怒り` (angry) and `困る` (troubled); use only the ones listed in `morphs`. MMD models have no clips (`clips` is empty), and hair or skirt physics and `.vmd` motions are not supported. The avatar still breathes, blinks, follows the pointer and lip-syncs, so leave `clip` out of every state.
- **`.blend`**: if Blender is installed, export a GLB in the background, with both paths under the model folder: `blender -b "models/<slug>/file.blend" --python-expr "import bpy; bpy.ops.export_scene.gltf(filepath='$PWD/models/<slug>/file-export.glb')"` (a bare `filepath` would land in the work folder root, so keep the `$PWD/models/<slug>/` prefix). Otherwise ask the user to export glTF/GLB from Blender.
- **`.unitypackage`, `.max`, `.c4d`, `.ma`, `.mb`**: cannot be converted here; ask the user to export FBX, GLB or VRM from the original app.
- **Live2D** (`.model3.json`, `.moc3`): refuse, and **tell the user the reason** in your reply: Live2D Cubism requires a separate publication licence for apps that load arbitrary user models, so Live3D does not support them. Suggest a VRM or GLB avatar instead.

## Tools

- Use host tools: `list_dir`, `read_file` (JSON and text only, not binaries), `view_image` (preview.png, textures), `write_file`, and `run_bash` for read-only probing (`ls -la`, `file`, `tar -tf`, the node one-liner above), extracting archives, copying and converting inside the model folder.
- **Never use `run_python`**: it runs in a sandbox that cannot see the user's files. Host `python3` through `run_bash` is fine if you need it.
- Every `run_bash` command may ask the user for approval; say in one line what each command is for.
- **Looking at the rendered avatar**: `desk_screenshot` (unlock it with `load_tools` first) captures the Agent Desk as the user sees it. While the avatar is on the Desk the result says it is the plugin companion `plugin:live3d:avatar`, and that image is the avatar itself. Use it when the user asks how the model looks, or after a fix, and judge the pose, textures and materials yourself instead of asking the user for a screenshot. Do not call `desk_present` first: it swaps the avatar out for your file when the Desk is idle, and does nothing when Live3D replaces the Desk. What you might see:
  - Arms stretched straight out (T-pose): the arm bones were not recognized, so the arms never relax. Check the bone names; a Blender-converted MMD model uses `腕.L` / `腕.R`, which the plugin does recognize.
  - A washed-out, see-through or wrongly layered face or clothes: the materials are transparent, which is typical of a GLB converted from MMD. If the original `.pmx` is still in the folder, point `model` at it instead; it loads directly with its own materials.
  - Hands buried in a skirt or coat, arms pressed flat against the body, or a stiff mannequin look: that is the `pose` block, not the model. See **Idle pose**.

## Finish

1. Write `models/<slug>/live3d.json` with `write_file` (two-space indented JSON; use the absolute path when your cwd is not the work folder).
2. Read it back and check: `"live3d": 1`; `model` exists in the folder with a supported extension; every `motions` path exists; `states` keys are phase names only; every `clip` is an exact name from `clips[].name` (or a clip you know the plugin will create from a motion file); weights are between 0 and 1; `framing` and `upAxis` use the allowed values; every slug in `agents` is a real agent; every `pose` number is inside its range. One bad value rejects the whole profile, and the library then shows the model with the validation message instead of loading it.
3. Tell the user the path you wrote and one line on what the model supports (clips mapped, expressions, lip sync or not).
4. How the avatar gets onto the Desk depends on who created the folder:
   - **The Live3D plugin opened this chat**: it watches this model folder, so the model loads and goes on the Desk by itself.
   - **You created the folder** (Step 0), or the user asked you to fix an existing model: the Desk does not switch on its own. Tell the user to open the model library (command palette: "Live3D: Open model library" / "Live3D:打开模型库"), click the model, and press "Use on the Desk" / "设为 Desk 形象". If the library was already open, the new model appears after "Live3D: Refresh model library" / "Live3D:刷新模型库". Once a model is on the Desk, later edits to its `live3d.json` reload automatically.
   - If the library lists a problem for the model, it shows the exact validation message — fix the file and write it again.

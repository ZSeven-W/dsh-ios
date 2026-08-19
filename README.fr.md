<p align="center">
  <img src="./docs/images/dsh-ios-logo.png" alt="DSH iOS" width="120" />
</p>

<h1 align="center">DSH Simulateur iOS</h1>

<p align="center">
  <strong>Un simulateur iOS en direct et interactif au cœur d'une conversation <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> — plus votre vrai iPhone par USB.</strong><br />
  <sub>21 outils pour l'agent &bull; panneau latéral MJPEG en direct &bull; simulateur et vrai iPhone par USB &bull; actions sur les lignes de listes/flux &bull; rechargement à chaud des aperçus SwiftUI</sub>
</p>

<p align="center">
  <sub>npm: <code>@zseven-w/dsh-ios</code> &middot; Version actuelle du plugin : <code>0.1.0-rc.1</code> &middot; Testé avec DSH <code>0.1.0-rc.6</code></sub>
</p>

<p align="center">
  <a href="./README.md">English</a> &middot;   <a href="./README.zh.md">简体中文</a> &middot;   <a href="./README.zh-TW.md">繁體中文</a> &middot;   <a href="./README.ja.md">日本語</a> &middot;   <a href="./README.ko.md">한국어</a> &middot;   <b>Français</b> &middot;   <a href="./README.es.md">Español</a> &middot;   <a href="./README.de.md">Deutsch</a> &middot;   <a href="./README.pt.md">Português</a> &middot;   <a href="./README.ru.md">Русский</a> &middot;   <a href="./README.hi.md">हिन्दी</a> &middot;   <a href="./README.tr.md">Türkçe</a> &middot;   <a href="./README.th.md">ไทย</a> &middot;   <a href="./README.vi.md">Tiếng Việt</a> &middot;   <a href="./README.id.md">Bahasa Indonesia</a>
</p>

<p align="center">
  <sub>rc : <code>0.1.0-rc.1</code> n'est pas encore publié sur npm — voir <a href="#installation-dans-dsh">Installation</a></sub>
</p>

<br />

<p align="center">
  <img src="./docs/images/dsh-ios-overview.png" alt="DSH iOS Simulator — a real iPhone inside the conversation" width="100%" />
</p>
<p align="center"><sub>Un iPhone réel piloté depuis une conversation DSH — les appels d'outils à gauche, le panneau live à droite</sub></p>

## Pourquoi DSH Simulateur iOS

DSH Simulateur iOS met un vrai simulateur iOS à la disposition de l'agent au cœur de la conversation — et vous en donne les pixels. L'agent peut démarrer un appareil, compiler et exécuter un projet Xcode ou un package Swift, piloter l'interface par identité d'accessibilité ou par texte OCR, lire les journaux unifiés et inspecter les processus, les traces de pile et les fuites, tandis qu'un flux en direct de l'appareil s'affiche dans un panneau latéral persistant où vous pouvez toucher, faire glisser, faire pivoter et appuyer sur Accueil directement sur la vidéo. Les mêmes opérations fonctionnent aussi sur un vrai iPhone connecté par USB : le plugin compile et lance WebDriverAgent sur le téléphone, tunnelise ses ports de contrôle et d'écran en boucle locale et diffuse l'appareil dans le même panneau, les mêmes cartes et les mêmes outils. Pas de blocs d'image, pas de fichiers d'enregistrement d'écran : les octets visuels n'atteignent l'interface qu'à travers des URL signées et expirantes servies par le serveur web de DSH.

| | |
| --- | --- |
| 🖥️ **Simulateur en direct dans la conversation** | Un flux MJPEG serve-sim de l'appareil démarré, relayé par les routes signées `/_dsh/dsh-ios/*` vers un panneau persistant à droite — le navigateur ne touche jamais le port de serve-sim. |
| 📱 **iPhone réel par USB** | `ios_real_start_wda` compile et lance WebDriverAgent sur un téléphone connecté et tunnelise ses ports de contrôle (REST) et d'écran (MJPEG) en boucle locale ; le même panneau, les mêmes outils, cartes et la même capsule d'état pilotent ensuite le téléphone. L'appareil doit être déverrouillé, et chaque appui sur un compte réel est soumis aux règles « identifier avant de toucher » du plugin. |
| 🛠️ **21 outils pour l'agent** | Appareils, démarrage/arrêt, capture d'écran, interaction, compilation et exécution, journaux unifiés, arbre d'interface basé sur AXe + appui par élément, actions sur les lignes de listes/flux, recherche/appui par OCR Vision, rechargement à chaud des aperçus SwiftUI, processus, trace de pile, fuites, informations d'app. |
| 👆 **Panneau interactif** | Touchez et faites glisser sur la vidéo en direct ; barre d'outils d'icônes Accueil / rotation / capture / actualisation avec infobulles au survol ; modes de taille (适应 · 50–125% · S/M/L) ; styles de cadre (无框 / 边框 / 真机框) ; redimensionnement par glissement jusqu'à 960 px avec réinitialisation par double-clic ; élargissement automatique en paysage. |
| 🧾 **Lignes de listes & flux** | `ios_sim_ui_rows` transforme des instantanés d'accessibilité profonds en lignes indexées avec étiquettes et compteurs génériquement analysés ; `ios_sim_tap_row` touche à l'intérieur d'une ligne à des coordonnées relatives et vérifie l'action par la variation attendue de ±1 du compteur — la seule confirmation fiable qu'offre une app de liste. |
| 🔐 **Transport en boucle locale uniquement** | serve-sim se lie à 127.0.0.1 sur une plage de ports dédiée ; chaque route exige un pair en boucle locale, un `Host` en boucle locale et des vérifications Fetch-Metadata/Origin ; les capacités HMAC expirent sous 10 minutes.. |
| ⚡ **Rechargement à chaud des aperçus SwiftUI** | `ios_sim_preview` génère une app hôte jetable en dehors de votre package, compile vos aperçus en dylib et injecte à chaud les modifications dans le simulateur en cours d'exécution sans le relancer (~2–5 s). |
| 🧭 **Automatisation sémantique de l'interface** | `ios_sim_ui_tree` exporte l'arbre d'accessibilité (basé sur AXe) et `ios_sim_tap_element` touche par étiquette ou identifiant ; `ios_sim_find_text` fait l'OCR de l'écran quand l'arbre est vide ou dégénéré, et `ios_sim_tap_text` touche le texte trouvé — des appuis fondés sur l'identité et le texte plutôt que sur des coordonnées devinées. |

## Outils

Les 21 outils sont enregistrés sur tous les hôtes et renvoient du JSON brut — les octets visuels n'atteignent l'interface qu'à travers `presentationMeta` + les routes signées, jamais sous forme de blocs d'image. Les udid de simulateur passent par simctl/serve-sim ; les udid d'appareil physique passent automatiquement par WebDriverAgent. Sur les hôtes non macOS (ou quand serve-sim est impossible à résoudre), les outils restent enregistrés mais échouent avec une erreur explicative ; la seule exception est `ios_sim_preview` `status`, qui rapporte fidèlement `{ running: false }` sur n'importe quel hôte.

### Outils principaux du simulateur

| Outil | Description | Paramètres clés |
| --- | --- | --- |
| `ios_sim_devices` | Liste les appareils du simulateur iOS disponibles sur ce Mac (udid, nom, runtime, état) et lesquels sont démarrés, plus les iPhone physiques connectés par USB sous `realDevices` (udid, nom, osVersion, model, state, developerMode). Utilisez-le pour trouver l'udid ou le nom à passer aux autres outils. | — |
| `ios_sim_boot` | Démarre un appareil et lance son flux serve-sim en direct ; le flux reste actif pendant toute la conversation pour que le panneau puisse afficher le simulateur en direct. | `udid` (obligatoire — udid ou nom d'appareil) |
| `ios_sim_shutdown` | Éteint un appareil ; arrête le flux quand il cible cet appareil. | `udid` (obligatoire) |
| `ios_sim_screenshot` | Capture un PNG et renvoie un bref résumé JSON (chemin, octets, dimensions, appareil) ; l'image s'affiche dans la carte/le panneau, jamais sous forme de bloc d'image. Fonctionne sur le simulateur en diffusion et sur un téléphone connecté par USB via WebDriverAgent. | `udid` (facultatif — appareil en diffusion, sinon le premier démarré) |
| `ios_sim_interact` | Interagit avec l'appareil en diffusion — simulateur ou téléphone connecté par USB : appui à des coordonnées normalisées 0..1, saisie de texte (clavier US sur un simulateur), appui sur un bouton matériel (`home`, `lock`, `volumeUp`…), défilement ou envoi d'un geste tactile ; une fois l'action stabilisée (~300 ms), une nouvelle capture montre l'effet. | `action` (obligatoire — `tap`/`type`/`button`/`gesture`/`scroll`), `x`/`y`, `text`, `name`, `json` |
| `ios_sim_list_apps` | Liste les apps INSTALLÉES sur un simulateur démarré ou un téléphone connecté (bundle id, nom d'affichage, version, indicateur système) — impossible de deviner le bundle id d'une app tierce : listez-le ou passez `name` à `ios_sim_launch_app`. Un échec de la liste lève une erreur (p. ex. "the device is not reachable by CoreDevice") au lieu de renvoyer une liste vide, donc `count: 0` signifie toujours que l'appareil n'a vraiment aucune app correspondante. | `udid` (facultatif), `query` (sous-chaîne insensible à la casse sur le nom d'affichage ET le bundle id, CJK inclus), `include_system` (false par défaut) |
| `ios_sim_launch_app` | Lance une app installée sur un simulateur démarré ou un téléphone connecté — par `bundleId`, ou par `name` (sous-chaîne du nom d'affichage insensible à la casse, résolue via la même liste, CJK inclus). Exactement l'un des deux ; un échec de lancement comme un nom ambigu renvoient tous deux la marche à suivre (`ios_sim_build_run` sert à en compiler une depuis les sources). | `bundleId` ou `name` (exactement l'un des deux), `udid`, `relaunch` |
| `ios_sim_build_run` | Compile un `.xcodeproj`, un `.xcworkspace` ou un package Swift pour le simulateur, installe l'`.app` produite et la lance ; passez un udid d'appareil physique pour compiler, installer et lancer sur le téléphone à la place (nécessite la signature Apple Development). En cas d'échec, le résultat contient la fin filtrée des erreurs `xcodebuild`. Une compilation complète prend plusieurs minutes. | `projectPath` (obligatoire), `scheme`, `udid` (en diffusion → démarré → iPhone au runtime le plus récent, qui est démarré), `configuration` (`Debug` par défaut) |
| `ios_real_start_wda` | Démarre WebDriverAgent (WDA) sur un iPhone physique connecté par USB — appareils réels uniquement, jamais un simulateur. Adopte un WDA déjà en cours d'exécution si l'un d'eux répond ; sinon lance la compilation/l'exécution `xcodebuild` (une compilation à froid prend plusieurs minutes), puis attend que WDA se déclare prêt et renvoie les ports de contrôle/MJPEG par lesquels le panneau en direct diffuse. Exécutez-le en premier quand `ios_sim_screenshot` / `ios_sim_interact` / `ios_sim_ui_tree` / `ios_sim_tap_element` signalent que WDA ne tourne pas pour l'appareil. | `udid` (obligatoire — udid d'appareil physique depuis `ios_sim_devices.realDevices`) |

### Outils d'arbre d'interface (basés sur AXe)

| Outil | Description | Paramètres clés |
| --- | --- | --- |
| `ios_sim_ui_tree` | Exporte l'arbre des éléments d'accessibilité de l'app au premier plan (étiquettes, identifiants, valeurs, cadres en points d'appareil) plus la taille de l'écran en points — AXe sur un simulateur, WebDriverAgent sur un téléphone connecté par USB (profondeur plafonnée par défaut dans ce cas : un instantané sans plafond d'une app chargée mesure ~32 s / 751 KB, plafonné ~2 s) ; la sortie est plafonnée à ~40 KB (les niveaux les plus profonds sont élagués, `truncated` + indication définis). | `udid` (facultatif), `max_depth`, `filter` (sous-chaîne insensible à la casse sur étiquette/identifiant/type) |
| `ios_sim_tap_element` | Touche un élément par identité — correspondance exacte d'abord, puis sous-chaîne insensible à la casse sur `identifier`/`label` ; les doublons imbriqués sont réduits à une seule cible, les correspondances ambiguës listent tous les candidats. L'appui atterrit au centre de l'élément (AXe HID sur un simulateur, WebDriverAgent sur un téléphone), puis une capture ~300 ms plus tard montre l'effet ; passez `expect_text` / `expect_gone` et l'appui plus sa vérification deviennent un seul aller-retour (`expected.matched`). | `udid` (facultatif), `identifier`, `label`, `expect_text`, `expect_gone` |

### Lignes de listes & flux

Les apps de listes/flux agrègent chaque élément dans une cellule d'accessibilité unique dont l'étiquette porte tout le résumé et tous ses compteurs ("57 回复。18 喜欢。592 次查看") — il n'y a pas de boutons enfants par contrôle à cibler, et les cellules de ligne n'apparaissent qu'à un instantané profond. Ces deux outils exposent cette structure sous forme de lignes et agissent à l'intérieur d'une ligne.

| Outil | Description | Paramètres clés |
| --- | --- | --- |
| `ios_sim_ui_rows` | Lit les lignes de listes/flux visibles de l'app au premier plan sous forme de lignes plutôt que d'arbre brut : chaque ligne rapporte son index, son cadre en points, l'étiquette agrégée et les compteurs extraits de cette étiquette (nombre + jeton de classification, p. ex. `57 回复` → 回复=57, chinois ou anglais — aucun vocabulaire d'app codé en dur). Les lignes n'apparaissent qu'à un instantané profond : sur un téléphone, le `max_depth` par défaut est de 60, soit ~15–25 s / ~0,5 MB par appel (WDA sert les requêtes en série) — gardez d'abord les observateurs peu coûteux (`ios_sim_find_text` / `ios_sim_ui_tree`). Les compteurs sont analysés heuristiquement et les clés font l'aller-retour : passez une clé exactement telle qu'elle est listée à `ios_sim_tap_row.expect_count`. Quand aucune ligne n'est trouvée, le résultat en donne la raison (profondeur trop faible / pas un écran de liste / réellement aucune information d'accessibilité après une lecture profonde) — une lecture superficielle n'est jamais signalée comme « l'app n'a aucune information d'accessibilité » ; les lignes hors écran sont exclues et comptées comme `omittedOffscreen`. | `udid` (facultatif), `max_depth` (téléphone uniquement ; 60 par défaut) |
| `ios_sim_tap_row` | Touche à une position relative à l'intérieur d'une ligne de liste visible (rapportée par `ios_sim_ui_rows` : index en base 0 ; x/y en fractions du cadre de cette ligne — 0 = bord gauche/haut, 1 = droite/bas, 0.5 = centre par défaut) sur un simulateur (AXe) ou un téléphone connecté par USB (WebDriverAgent). Le cadre de la ligne provient d'une lecture d'arbre FRAÎCHE, donc aucune coordonnée d'écran absolue n'est devinée ; un index hors limites ÉCHOUE (jamais borné). Garde-fou : avec `expect_count={key,delta}`, l'outil vérifie l'action en relisant l'étiquette de la ligne et en contrôlant que le compteur a bougé d'exactement +1/−1 (`countCheck.verified`) ; si la clé ne figure pas parmi les compteurs analysés de la ligne, l'appui est REFUSÉ avant d'avoir lieu — un appui sur appareil réel n'est jamais une sonde. Sans `expect_count`, l'appui a quand même lieu (une position relative à la ligne explicite EST l'identification) mais rien n'est vérifié. | `udid` (facultatif), `index` (obligatoire), `x`, `y` (fractions 0..1), `max_depth`, `expect_count` (`{key, delta}`) |

### Outils OCR (Vision)

| Outil | Description | Paramètres clés |
| --- | --- | --- |
| `ios_sim_find_text` | Fait l'OCR de l'écran ACTUEL d'un simulateur démarré ou d'un téléphone connecté par USB avec l'assistant Vision compilé par le plugin (reconnaissance précise, zh-Hans + en-US, compilé avec `swiftc` à la première utilisation dans `~/Library/Caches/dsh-ios/bin/ocr`). Utilisez-le quand l'arbre d'accessibilité est vide ou dégénéré, pour du texte rendu sous forme de graphiques (badges de compteur, prix incrustés dans des images) ou pour vérifier indépendamment ce qui est à l'écran. Capture un nouvel instantané et renvoie `{device, size, items:[{text, confidence, rect}]}` — les rect sont des boîtes en points d'appareil (origine en haut à gauche), triées par confiance, plafonnées à ~40 KB (`truncated` retire la queue à plus faible confiance ; affinez avec `query` ou augmentez `min_confidence`). | `udid` (facultatif), `query` (sous-chaîne insensible à la casse), `min_confidence` (0.3 par défaut) |
| `ios_sim_tap_text` | Fait l'OCR de l'écran ACTUEL et touche le centre de la meilleure correspondance textuelle — les mêmes règles d'ambiguïté exact → contient (insensible à la casse) → liste de candidats que `ios_sim_tap_element`, pour le texte que l'arbre d'accessibilité ne voit pas (apps sans a11y, badges de compteur, texte incrusté dans des images). Sur un téléphone, l'appui atterrit à des points d'appareil absolus via WebDriverAgent ; sur le simulateur en diffusion, il est envoyé normalisé via le contrôle serve-sim (exécutez d'abord `ios_sim_boot`). ~300 ms plus tard, une nouvelle capture montre l'effet ; passez `expect_text` / `expect_gone` et l'appui plus sa vérification deviennent un seul aller-retour (`expected.matched`). Sur un appareil RÉEL, chaque appui a des conséquences réelles — ne touchez jamais un contrôle non identifié pour découvrir ce qu'il fait. | `udid` (facultatif), `query` (obligatoire), `min_confidence`, `expect_text`, `expect_gone` |

### Outil de journaux

| Outil | Description | Paramètres clés |
| --- | --- | --- |
| `ios_sim_logs` | Lit ce qu'une app du simulateur affiche, depuis le journal unifié de l'appareil : `snapshot` (`log show --last <duration>`, 2m par défaut) ou `follow` (capture en direct bornée pendant `duration_seconds`, 10 par défaut, 60 max — jamais un flux qui se bloque). La sortie est plafonnée à ~300 lignes / 30 KB avec une indication pour affiner. | `udid` (facultatif), `mode` (`snapshot`/`follow`), `duration`, `duration_seconds`, `bundle_id`, `predicate` (NSPredicate brut, remplace `bundle_id`), `level` (`default`/`info`/`debug`), `grep` |

### Outil d'aperçu

| Outil | Description | Paramètres clés |
| --- | --- | --- |
| `ios_sim_preview` | Rechargement à chaud des aperçus SwiftUI, en direct dans le simulateur : `start` (par défaut) valide le package, génère une app hôte jetable dans le cache du plugin (jamais dans votre package), compile le package en dylib pour le simulateur, installe + lance l'hôte et surveille les sources — chaque modification recompile et s'injecte à chaud sans relancer (~2–5 s). Les erreurs de compilation conservent le dernier bon aperçu et remontent via `status` ; une session à la fois. | `packagePath` (obligatoire pour `start`), `udid`, `action` (`start`/`status`/`stop`), `previewFilter` (sous-chaîne insensible à la casse sur les noms d'aperçus) |

### Outils de débogage

| Outil | Description | Paramètres clés |
| --- | --- | --- |
| `ios_sim_processes` | Liste les processus d'app en cours d'exécution d'un simulateur depuis son propre launchd (pid visible de l'hôte, nom, bundle id) — la source de pid pour les traces de pile/les fuites ; un udid d'appareil physique liste les processus du téléphone via devicectl à la place. | `udid` (facultatif), `filter` (sous-chaîne insensible à la casse sur nom/bundle id) |
| `ios_sim_backtrace` | LLDB en lot à usage unique (attach → thread backtrace → detach, jamais interactif) ; sortie plafonnée à ~200 lignes, thread principal en premier, la cible est toujours vérifiée comme reprise. Quand macOS refuse l'attachement (mode développeur désactivé), il retombe sur le moteur `sample` non suspensif de Xcode et rapporte l'indication pour l'activer. Simulateurs uniquement — les appareils physiques sont rejetés avec la raison. | `udid` (facultatif), `pid` / `bundle_id`, `all_threads` (true par défaut) |
| `ios_sim_leaks` | Analyse les fuites avec l'outil `leaks` de Xcode : `summary` (nombre de fuites, total d'octets ayant fui, ~30 principaux types) ou `memgraph` (un artefact `.memgraph` à ouvrir dans Xcode Instruments, jamais analysé ici). L'app est suspendue pendant l'analyse et toujours reprise. Simulateurs uniquement. | `udid` (facultatif), `pid` / `bundle_id`, `mode` (`summary`/`memgraph`) |
| `ios_sim_app_info` | Faits sur une app installée : chemin du bundle de l'app, conteneur de données accessible en écriture et valeurs Info.plist — via `simctl appinfo` (avec un repli sur `get_app_container`) sur un simulateur, via `devicectl` sur un téléphone connecté par USB ; `installed: false` plus une `note` désignant `ios_sim_list_apps` pour les apps manquantes. | `udid` (facultatif), `bundle_id` (obligatoire) |

## Surfaces d'affichage

- **Panneau latéral — “iOS 模拟器”.** La vue en direct vit dans un panneau persistant à droite (un dock fixe qui écarte la conversation, ou une superposition centrée sur les viewports étroits). Il affiche le flux MJPEG en direct et accepte directement sur la vidéo le clic-pour-toucher et le glisser-pour-geste, avec une barre d'outils d'icônes (Accueil, capture, rotation, actualisation) dont les boutons portent des infobulles au survol. Les contrôles de taille offrent **适应** (s'adapte à la largeur du panneau), un zoom **50–125%** de la largeur logique de l'appareil et des préréglages **S / M / L** qui dimensionnent le petit côté de l'appareil (largeur en portrait ; le paysage met à l'échelle pour que l'appareil conserve sa taille physique). Les styles de cadre sont **无框 / 边框 / 真机框** (sans cadre / fine bordure / coque réaliste d'appareil) avec un rayon d'angle proportionnel. Quand l'appareil pivote en paysage, le panneau s'élargit automatiquement à une taille confortable et restaure votre largeur quand il revient — un glissement manuel pendant la séquence l'emporte toujours. La poignée du bord gauche élargit/rétrécit le panneau (960 px max ; un double-clic revient à la largeur par défaut). Quand un iPhone connecté par USB est la cible du flux, le même panneau affiche le flux MJPEG WebDriverAgent du téléphone avec les mêmes contrôles.
- **Cartes de conversation compactes.** Les résultats d'outils s'affichent sous forme de cartes d'une ligne sans aucune image intégrée : le titre unifié **“iOS 模拟器”**, un sous-libellé d'action (Boot / Screenshot / Interact / Build &amp; Run / Start WebDriverAgent), le nom de l'appareil, un badge d'état et une invite « ouvrir dans le panneau latéral ». Cliquer sur la ligne ouvre le panneau ; les clics sur les boutons, les liens ou le cadre en direct lui-même ne le déclenchent jamais.
- **Capsule d'état au-dessus de la saisie.** Quand le panneau est fermé et qu'un flux est en ligne, une petite pastille à point vert (`<appareil> · 实时`) apparaît au-dessus de la zone de saisie et ouvre le panneau quand on clique dessus. Elle est limitée à la session : elle s'affiche et interroge uniquement tant que la conversation courante a monté des résultats de simulateur, et s'arrête quand vous basculez vers une session qui n'en a pas.
- **Mode standard et mode Code.** Les sessions standard utilisent le `presentationMeta` projeté par l'hôte. Les envois imbriqués du mode Code (PTC) ne transportent jamais de meta, donc le client reconstruit le meta identique à partir du JSON de résultat durable — le panneau, les cartes et la capsule fonctionnent dans les deux modes.

## Sécurité

- Le navigateur ne parle jamais au port de serve-sim. Chaque octet traverse l'origine du serveur web de DSH par des routes `/_dsh/dsh-ios/*` appartenant au plugin : `/stream/<token>` (proxy MJPEG), `/screenshot/<token>` (PNG mis en cache), `/ws?token=…` (relais de contrôle HID), plus les endpoints `/grant`, `/capture` et `/status`.
- Les jetons sont des capacités HMAC-SHA256 (`base64url(payload).base64url(mac)`) expirant sous 10 minutes, signées avec une clé propre à chaque répertoire personnel DSH (`<DSH_HOME>/cache/dsh-ios/stream-access.key`, 0600, créée atomiquement).
- Chaque route applique une barrière de transport en boucle locale/de confiance avant de consulter la moindre capacité : adresse du pair en boucle locale, `Host` en boucle locale (rebinding DNS rejeté) et vérifications Fetch-Metadata/Origin. La route de capture ne sert que des fichiers situés dans le répertoire de cache du plugin (liens symboliques refusés, confinement par `realpath`).
- serve-sim s'exécute comme processus enfant au premier plan, en boucle locale uniquement, sur une plage de ports dédiée (3181–3244), de sorte que le serve-sim de l'utilisateur sur le port 3100 n'est jamais touché ; `--host` n'est jamais utilisé..
- **Adoption/récupération des orphelins** — si un hôte DSH précédent a été tué brutalement et que son assistant serve-sim a survécu, le même appareil est adopté (la poignée de main de l'orphelin fait foi) ; un assistant périmé qui squatte un emplacement destiné à un autre appareil est récupéré via `serve-sim -k` puis relancé une fois.
- **Keep-alive + arrêt en cas d'inactivité** — un flux qui plante redémarre en arrière-plan (~5 s de délai) ; sans aucun consommateur, le flux s'arrête automatiquement après 5 minutes. Les arrêts intentionnels ne sont jamais contrariés. (Le runner des appareils réels est volontairement exempté du moissonnage en cas d'inactivité : le redémarrer coûte une recompilation `xcodebuild` de plusieurs minutes.)

## Prérequis

- **macOS avec Xcode complet** — pas seulement les Command Line Tools. `xcodebuild`, `xcrun simctl` et les runtimes de simulateur sont tous fournis avec Xcode.
- **Au moins un runtime de simulateur iOS** installé dans Xcode.
- **DSH ≥ 0.1.0-rc.6 avec le bundle web** pour le panneau. Les profils headless fonctionnent aussi : les 21 outils marchent normalement, simplement sans la vue en direct.
- **Hôtes non macOS** : le plugin se charge et les 21 outils s'enregistrent, mais chaque appel renvoie une erreur explicative (`iOS Simulator requires macOS with Xcode …`).
- **serve-sim** est fourni comme dépendance npm de ce plugin, il se résout donc localement sur les vraies installations ; le repli `npx -y serve-sim` couvre les arborescences de développement (la première utilisation nécessite le réseau).
- **AXe** (facultatif — seuls les outils basés sur AXe en ont besoin : `ios_sim_ui_tree` / `ios_sim_tap_element`, plus `ios_sim_ui_rows` / `ios_sim_tap_row` sur un simulateur) : `brew install cameroncooke/axe/axe`, ou laissez le plugin télécharger automatiquement la version épinglée (v1.8.0, SHA-256 vérifiée) dans `~/Library/Caches/dsh-ios/bin`. `DSH_IOS_AXE_BIN` remplace la résolution ; `DSH_IOS_AXE_OFFLINE=1` désactive le téléchargement.
- **Vision OCR** (facultatif — seuls `ios_sim_find_text` / `ios_sim_tap_text` en ont besoin) : le plugin compile son `assets/ocr.swift` embarqué avec `swiftc` à la première utilisation dans `~/Library/Caches/dsh-ios/bin/ocr` (reconnaissance zh-Hans + en-US).
- **l'attachement lldb** nécessite le mode développeur de macOS : exécutez `sudo DevToolsSecurity -enable` une fois. D'ici là, `ios_sim_backtrace` utilise le moteur `sample` de Xcode (non suspensif) et `ios_sim_leaks` se dégrade avec l'indication pour l'activer.. La première compilation de WDA installe un WebDriverAgentRunner signé : faites confiance à son certificat sur l'appareil quand vous y êtes invité, et relancez `ios_real_start_wda` quand le profil de signature d'équipe gratuite expire (durée de vie de 7 jours).

## Installation dans DSH

```sh
dsh plugin --profile web add @zseven-w/dsh-ios@latest
dsh web
```

> **note rc** — `0.1.0-rc.1` n'est pas encore publié sur npm. En attendant, installez l'archive tarball empaquetée :
>
> ```sh
> npm pack                                   # in this repository → dsh-ios-0.1.0-rc.1.tgz
> dsh plugin --profile web add /path/to/dsh-ios-0.1.0-rc.1.tgz
> dsh web
> ```

## Démarrage rapide

Une première conversation type :

1. **Découvrir les appareils** — « Liste les simulateurs disponibles. » → `ios_sim_devices`.
2. **Démarrer** — « Démarre l'iPhone 17 Pro. » → `ios_sim_boot`. Le flux démarre et le **panneau “iOS 模拟器”** s'ouvre : l'appareil est en direct dans le panneau latéral. (Cliquez sur la ligne d'une carte de simulateur, ou sur la pastille d'état au-dessus de la saisie, pour le rouvrir.)
3. **Touchez la vidéo** — touchez ou faites glisser directement sur le panneau ; ou laissez l'agent piloter l'interface : « Ouvre Réglages, puis touche Général. » → `ios_sim_interact` (ou `ios_sim_ui_tree` + `ios_sim_tap_element` pour les appuis par identité ; `ios_sim_find_text` + `ios_sim_tap_text` pour les appuis par texte ; `ios_sim_ui_rows` + `ios_sim_tap_row` pour les apps de listes/flux).
4. **Compiler & exécuter votre app** — « Compile et exécute /path/to/MyApp.xcodeproj. » → `ios_sim_build_run`. Une compilation complète prend plusieurs minutes ; quand elle aboutit, l'app se lance sur le simulateur et vous la regardez en direct dans le panneau.
5. **Rechargement à chaud des aperçus** — « Montre les aperçus SwiftUI de /path/to/MyPackage. » → `ios_sim_preview start`. Modifiez un fichier source et l'aperçu s'injecte à chaud dans le simulateur en cours d'exécution en ~2–5 s — sans relancement.
6. **Piloter un iPhone réel** — branchez le téléphone en USB (câble de données), déverrouillez-le, puis « Démarre WebDriverAgent sur le téléphone. » → `ios_real_start_wda`. Le panneau bascule sur le flux en direct du téléphone et chaque outil accepte son udid de `realDevices` ; quand un appel échoue, lisez la raison codée dans l'état du panneau (`device-locked`, `cert-untrusted`, `profile-expired`, `tunnel-failed`, `device-unplugged`).

## Dépannage

- **La trace de pile utilise `sample` au lieu de lldb, ou les fuites se plaignent d'une inspection restreinte** — le mode développeur de macOS est désactivé. Exécutez `sudo DevToolsSecurity -enable` une fois puis réessayez. Les outils se dégradent proprement d'ici là : `ios_sim_backtrace` retombe sur le `sample` de Xcode (symbolisé, non suspensif) et `ios_sim_leaks` rapporte l'indication pour l'activer.
- **`ios_sim_ui_tree` / `ios_sim_tap_element` ont besoin d'AXe** — installez-le avec `brew install cameroncooke/axe/axe`, ou laissez le plugin télécharger la version épinglée à la première utilisation (nécessite le réseau vers github.com). Le message d'erreur porte toujours l'indication d'installation complète ; `DSH_IOS_AXE_BIN=/path/to/axe` remplace la résolution. Les outils de lignes (`ios_sim_ui_rows` / `ios_sim_tap_row`) ont aussi besoin d'AXe sur un simulateur.
- **`ios_sim_find_text` / `ios_sim_tap_text` signalent que l'assistant OCR est manquant** — la première utilisation compile l'`assets/ocr.swift` embarqué avec `swiftc` (nécessite Xcode) dans `~/Library/Caches/dsh-ios/bin/ocr` ; l'erreur porte le chemin exact et l'indication.
- **`ios_sim_ui_rows` ne trouve aucune ligne** — le résultat en donne la raison : profondeur trop faible (augmentez `max_depth` ; sur un téléphone, chaque instantané plus profond coûte ~15–25 s), pas un écran de liste, ou réellement aucune information d'accessibilité après une lecture profonde. Une lecture superficielle n'est jamais signalée à tort comme une accessibilité manquante.
- **`ios_sim_leaks` sur les simulateurs iOS 26.2** — sur les runtimes iOS 26.2, le `leaks` de Xcode peut échouer à inspecter les processus du simulateur avec des diagnostics fatals tels que `Failed to get DYLD info` ou des erreurs minimal-corpse, même avec le mode développeur activé. L'outil se dégrade proprement : vous obtenez le diagnostic brut, la cible est toujours vérifiée comme reprise et rien ne se bloque. Il n'y a pas de correctif côté plugin — quand cela se produit, essayez `mode: "memgraph"` ou un autre runtime..
- **Le flux s'arrête tout seul** — c'est la politique d'inactivité, pas un plantage : sans aucun consommateur (panneau fermé, aucune carte montée, aucune route active), le flux s'arrête après 5 minutes et redémarre au prochain appel d'outil ou à l'ouverture du panneau. Un flux qui plante redémarre en arrière-plan en ~5 secondes.

## Développement

```sh
pnpm install
pnpm run build      # host tsc + client bundle → lib/
pnpm run typecheck
```

Les smoke tests de `scripts/` exercent le `lib/` compilé (macOS uniquement pour les parties qui démarrent un simulateur ou parlent à un téléphone connecté par USB ; définissez `DSH_IOS_SMOKE_SKIP_SIM=1` pour sauter ces parties) :

| Script | Ce qu'il couvre |
| --- | --- |
| `node scripts/dev-smoke.mjs` | Hôte du simulateur : résolution des binaires, lancement du flux, contrôle, keep-alive, dispose. |
| `node scripts/dev-tools-smoke.mjs [--full-build]` | Les outils principaux face à un vrai simulateur (plus une vraie compilation avec `--full-build`). |
| `node scripts/dev-routes-smoke.mjs` | Routes web signées : grant, proxy de flux, capture, relais ws, barrières, expiration. |
| `node scripts/dev-card-smoke.mjs` | Cartes client : SSR statique (aucun `<img>`), contrat status/capture, partie réseau quasi en direct. |
| `node scripts/dev-panel-smoke.mjs` | Composants du panneau, modes de taille, styles de cadre, logique dock/déclencheur/capsule (statique uniquement). |
| `node scripts/dev-logs-smoke.mjs` | `ios_sim_logs` snapshot/follow, filtres, plafonds, moissonnage des processus. |
| `node scripts/dev-uitree-smoke.mjs` | Outils d'arbre d'interface : pipeline de résolution/téléchargement d'AXe, sélecteurs, arbre + appui sur vrai simulateur. |
| `node scripts/dev-debug-smoke.mjs` | Outils de débogage : processus, trace de pile (lldb + sample), fuites, infos d'app. |
| `node scripts/dev-preview-smoke.mjs` | Rechargement à chaud des aperçus : démarrage, modification → injection à chaud sans relancement, récupération d'erreur, arrêt. |
| `node scripts/dev-orphan-smoke.mjs` | Adoption/récupération d'un serve-sim orphelin après un arrêt brutal de l'hôte. |
| `node scripts/dev-ocr-smoke.mjs` | Outils Vision-OCR : résolution de l'assistant, cache de compilation swiftc, pipeline de reconnaissance, routage tap-text. |
| `node scripts/dev-wda-smoke.mjs` | Hôte WebDriverAgent : analyse de `ServerURLHere`, classification des échecs, tunnels, keep-alive (simulé ; passage en direct facultatif). |
| `node scripts/dev-realdevice-smoke.mjs` | `xcrun devicectl` face à un iPhone connecté par USB — les chemins de code exacts qu'utilisent les outils. |
| `node scripts/dev-realstart-smoke.mjs` | La route `/real-start` : barrière, refus codés, gating de compilation/lancement (statique). |
| `node scripts/dev-realtools-smoke.mjs` | Les backends sur appareil réel de `ios_sim_screenshot` / `ios_sim_interact` / `ios_sim_ui_tree` / `ios_sim_tap_element` plus `ios_real_start_wda`. |

## Écosystème

- [DSH Crew](https://github.com/ZSeven-W/dsh-crew) — déléguer des tâches aux agents DSH depuis Claude Code / Codex
- [DSH Noema](https://github.com/ZSeven-W/dsh-noema) — mémoire à long terme pour DSH
- [DSH OpenPencil](https://github.com/ZSeven-W/dsh-openpencil) — inspecter et modifier des documents `.op` dans une conversation

## Crédits & Licence

- [serve-sim](https://github.com/EvanBacon/serve-sim) — Evan Bacon — le moteur de diffusion du simulateur (Apache-2.0 ; dépendance runtime embarquée).
- [AXe](https://github.com/cameroncooke/AXe) — Cameron Cooke — la CLI d'accessibilité derrière les outils d'arbre d'interface (MIT).
- [WebDriverAgent](https://github.com/appium/WebDriverAgent) — le serveur WebDriver que le plugin compile et lance sur les appareils réels (sous licence BSD).
- Architecture inspirée du plugin « Build iOS Apps » de Codex ; le moteur d'aperçus SwiftUI est une réimplémentation en salle blanche (clean-room) de l'approche documentée publiquement — aucun code de Codex n'est copié.
- Voir [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) pour l'intégralité des mentions.

**Licence** : MIT

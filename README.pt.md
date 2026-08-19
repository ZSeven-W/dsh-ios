<p align="center">
  <img src="./docs/images/dsh-ios-logo.png" alt="DSH iOS" width="120" />
</p>

<h1 align="center">DSH Simulador iOS</h1>

<p align="center">
  <strong>Um Simulador de iOS ao vivo e interativo dentro de uma conversa do <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> — e também o seu iPhone real via USB.</strong><br />
  <sub>21 ferramentas do agente &bull; painel lateral MJPEG ao vivo &bull; simulador &amp; iPhone real via USB &bull; ações em linhas de listas/feeds &bull; hot reload de previews SwiftUI</sub>
</p>

<p align="center">
  <sub>npm: <code>@zseven-w/dsh-ios</code> &middot; Versão atual do plugin: <code>0.1.0-rc.1</code> &middot; Testado com DSH <code>0.1.0-rc.6</code></sub>
</p>

<p align="center">
  <a href="./README.md">English</a> &middot;   <a href="./README.zh.md">简体中文</a> &middot;   <a href="./README.zh-TW.md">繁體中文</a> &middot;   <a href="./README.ja.md">日本語</a> &middot;   <a href="./README.ko.md">한국어</a> &middot;   <a href="./README.fr.md">Français</a> &middot;   <a href="./README.es.md">Español</a> &middot;   <a href="./README.de.md">Deutsch</a> &middot;   <b>Português</b> &middot;   <a href="./README.ru.md">Русский</a> &middot;   <a href="./README.hi.md">हिन्दी</a> &middot;   <a href="./README.tr.md">Türkçe</a> &middot;   <a href="./README.th.md">ไทย</a> &middot;   <a href="./README.vi.md">Tiếng Việt</a> &middot;   <a href="./README.id.md">Bahasa Indonesia</a>
</p>

<p align="center">
  <sub>rc: <code>0.1.0-rc.1</code> ainda não foi publicado no npm — veja <a href="#instalar-no-dsh">Instalar</a></sub>
</p>

<br />

<p align="center">
  <img src="./docs/images/dsh-ios-overview.png" alt="DSH iOS Simulator — a real iPhone inside the conversation" width="100%" />
</p>
<p align="center"><sub>Um iPhone real controlado a partir de uma conversa DSH — chamadas de ferramentas à esquerda, painel ao vivo à direita</sub></p>

## Por que o DSH Simulador iOS

O DSH Simulador iOS dá ao agente um Simulador de iOS real dentro da conversa — e dá a você os pixels. O agente pode iniciar um dispositivo, compilar e executar um projeto Xcode ou pacote Swift, controlar a interface por identidade de acessibilidade ou por texto via OCR, ler os logs unificados e inspecionar processos, backtraces e vazamentos, enquanto um fluxo ao vivo do dispositivo é renderizado em um painel lateral persistente onde você pode tocar, arrastar, girar e pressionar o botão Home diretamente sobre o vídeo. Os mesmos verbos também funcionam em um iPhone real conectado via USB: o plugin compila e inicia o WebDriverAgent no telefone, encaminha as portas de controle e de tela por túneis de loopback e transmite o dispositivo para o mesmo painel, cards e ferramentas. Sem blocos de imagem, sem arquivos de gravação de tela: os bytes visuais chegam à interface apenas por URLs assinadas e com expiração servidas pelo webserver do DSH.

| | |
| --- | --- |
| 🖥️ **Simulador ao vivo na conversa** | Um fluxo MJPEG do serve-sim com o dispositivo iniciado, passado por rotas assinadas `/_dsh/dsh-ios/*` para um painel persistente no lado direito — o navegador nunca toca a porta do serve-sim. |
| 📱 **iPhone real via USB** | `ios_real_start_wda` compila e inicia o WebDriverAgent em um telefone conectado e encaminha as portas de controle (REST) e de tela (MJPEG) por túneis de loopback; o mesmo painel, ferramentas, cards e cápsula de status passam a controlar o telefone. O dispositivo precisa estar desbloqueado, e todo toque em conta real passa pelas regras de identificar-antes-de-tocar do plugin. |
| 🛠️ **21 ferramentas do agente** | Dispositivos, iniciar/desligar, captura de tela, interação, compilar &amp; executar, logs unificados, árvore de UI baseada em AXe + toque por elemento, ações em linhas de listas/feeds, localizar/tocar via OCR do Vision, hot reload de previews SwiftUI, processos, backtrace, vazamentos, informações do app. |
| 👆 **Painel interativo** | Toque e arraste sobre o vídeo ao vivo; barra de ícones Home / girar / captura de tela / atualizar com tooltips ao passar o mouse; modos de tamanho (适应 · 50–125% · S/M/L); estilos de moldura (无框 / 边框 / 真机框); redimensionar arrastando até 960 px com reset no duplo clique; alargamento automático em paisagem. |
| 🧾 **Linhas de listas &amp; feeds** | `ios_sim_ui_rows` transforma snapshots profundos de acessibilidade em linhas indexadas com rótulos e contadores interpretados de forma genérica; `ios_sim_tap_row` toca dentro de uma linha em coordenadas relativas e verifica a ação pela mudança esperada de ±1 no contador — a única confirmação confiável que um app de lista oferece. |
| 🔐 **Transporte somente por loopback** | o serve-sim faz bind em 127.0.0.1 em uma faixa de portas dedicada; toda rota exige um par em loopback, um `Host` de loopback e verificações de Fetch-Metadata/Origin; as capabilities HMAC expiram em até 10 minutos.. |
| ⚡ **Hot reload de previews SwiftUI** | `ios_sim_preview` gera um app host descartável fora do seu pacote, compila seus previews como uma dylib e aplica edições a quente no simulador em execução sem relançar (~2–5 s). |
| 🧭 **Automação de UI semântica** | `ios_sim_ui_tree` despeja a árvore de acessibilidade (baseada em AXe) e `ios_sim_tap_element` toca por rótulo ou identificador; `ios_sim_find_text` faz OCR da tela quando a árvore está vazia ou degenerada, e `ios_sim_tap_text` toca o texto correspondente — toques por identidade e por texto em vez de coordenadas adivinhadas. |

## Ferramentas

Todas as 21 ferramentas são registradas em todos os hosts e retornam JSON puro — os bytes visuais chegam à interface apenas por `presentationMeta` + rotas assinadas, nunca como blocos de imagem. UDIDs de simulador passam por simctl/serve-sim; UDIDs de dispositivos físicos passam automaticamente pelo WebDriverAgent. Em hosts não macOS (ou quando o serve-sim não pode ser resolvido), as ferramentas continuam registradas, mas falham com um erro explicativo; a única exceção é o `status` do `ios_sim_preview`, que reporta com veracidade `{ running: false }` em qualquer host.

### Ferramentas principais do simulador

| Ferramenta | O que ela faz | Parâmetros principais |
| --- | --- | --- |
| `ios_sim_devices` | Lista os dispositivos do Simulador de iOS disponíveis neste Mac (udid, nome, runtime, estado) e quais estão iniciados, além de qualquer iPhone físico conectado via USB em `realDevices` (udid, nome, osVersion, model, state, developerMode). Use-o para descobrir o udid ou o nome a passar para as outras ferramentas. | — |
| `ios_sim_boot` | Inicia um dispositivo e começa seu fluxo ao vivo do serve-sim; o fluxo permanece ativo durante a conversa para que o painel possa mostrar o simulador ao vivo. | `udid` (obrigatório — udid ou nome do dispositivo) |
| `ios_sim_shutdown` | Desliga um dispositivo; interrompe o fluxo quando ele tem esse dispositivo como alvo. | `udid` (obrigatório) |
| `ios_sim_screenshot` | Captura um PNG e retorna um resumo JSON pequeno (caminho, bytes, dimensões, dispositivo); a imagem é renderizada no card/painel, nunca como um bloco de imagem. Funciona no simulador em fluxo e em um telefone conectado via USB através do WebDriverAgent. | `udid` (opcional — dispositivo em fluxo; senão, o primeiro iniciado) |
| `ios_sim_interact` | Interage com o dispositivo em fluxo — simulador ou telefone conectado via USB: toca em coordenadas normalizadas 0..1, digita texto (teclado dos EUA no simulador), pressiona um botão de hardware (`home`, `lock`, `volumeUp`…), rola a tela ou envia um gesto de toque; depois que a ação estabiliza (~300 ms), uma nova captura de tela mostra o efeito. | `action` (obrigatório — `tap`/`type`/`button`/`gesture`/`scroll`), `x`/`y`, `text`, `name`, `json` |
| `ios_sim_list_apps` | Lista os apps INSTALADOS em um simulador iniciado ou em um telefone conectado (bundle id, nome de exibição, versão, flag de sistema) — um bundle id de terceiros não pode ser adivinhado, então liste-o ou passe `name` para `ios_sim_launch_app`. Uma listagem que FALHA lança erro (ex.: "o dispositivo não está acessível pelo CoreDevice") em vez de retornar uma lista vazia, então `count: 0` sempre significa que o dispositivo realmente não tem nenhum app correspondente. | `udid` (opcional), `query` (substring sem distinção de maiúsculas/minúsculas sobre o nome de exibição E o bundle id, incluindo CJK), `include_system` (padrão false) |
| `ios_sim_launch_app` | Inicia um app instalado em um simulador iniciado ou em um telefone conectado — por `bundleId`, ou por `name` (uma substring do nome de exibição sem distinção de maiúsculas/minúsculas, resolvida pela mesma listagem, incluindo CJK). Exatamente um dos dois; uma falha de inicialização e um nome ambíguo retornam ambos com o que fazer em seguida (`ios_sim_build_run` é para compilar um a partir do código-fonte). | `bundleId` ou `name` (exatamente um), `udid`, `relaunch` |
| `ios_sim_build_run` | Compila um `.xcodeproj`, `.xcworkspace` ou pacote Swift para o simulador, instala o `.app` gerado e o inicia; passe um udid de dispositivo físico para compilar, instalar e iniciar no telefone (exige assinatura Apple Development). Em caso de falha, o resultado traz o final filtrado do erro do `xcodebuild`. Uma compilação completa leva minutos. | `projectPath` (obrigatório), `scheme`, `udid` (em fluxo → iniciado → iPhone de runtime mais novo, que é iniciado), `configuration` (padrão `Debug`) |
| `ios_real_start_wda` | Inicia o WebDriverAgent (WDA) em um iPhone físico conectado via USB — somente dispositivos reais, nunca um simulador. Adota um WDA já em execução quando um responde; caso contrário, executa a compilação/inicialização do `xcodebuild` (uma compilação fria leva minutos) e então espera até o WDA reportar que está pronto e retorna as portas de controle/MJPEG pelas quais o painel ao vivo transmite. Execute isto primeiro quando `ios_sim_screenshot` / `ios_sim_interact` / `ios_sim_ui_tree` / `ios_sim_tap_element` reportarem que o WDA não está em execução para o dispositivo. | `udid` (obrigatório — udid de dispositivo físico de `ios_sim_devices.realDevices`) |

### Ferramentas de árvore de UI (baseadas em AXe)

| Ferramenta | O que ela faz | Parâmetros principais |
| --- | --- | --- |
| `ios_sim_ui_tree` | Despeja a árvore de elementos de acessibilidade do app em primeiro plano (rótulos, identificadores, valores, frames em pontos do dispositivo) mais o tamanho da tela em pontos — AXe em um simulador, WebDriverAgent em um telefone conectado via USB (com limite de profundidade por padrão: um snapshot sem limite de um app com muita atividade mede ~32 s / 751 KB, com limite ~2 s); a saída é limitada a ~40 KB (níveis mais profundos podados, `truncated` + dica definidos). | `udid` (opcional), `max_depth`, `filter` (substring sem distinção de maiúsculas/minúsculas sobre rótulo/identificador/tipo) |
| `ios_sim_tap_element` | Toca um elemento por identidade — correspondência exata primeiro, depois substring sem distinção de maiúsculas/minúsculas sobre `identifier`/`label`; duplicatas aninhadas colapsam em um único alvo, correspondências ambíguas listam todos os candidatos. O toque cai no centro do elemento (AXe HID em um simulador, WebDriverAgent em um telefone) e, após ~300 ms, uma captura de tela mostra o efeito; passe `expect_text` / `expect_gone` e o toque mais sua verificação viram uma única ida e volta (`expected.matched`). | `udid` (opcional), `identifier`, `label`, `expect_text`, `expect_gone` |

### Linhas de listas &amp; feeds

Apps de lista/feed agregam cada item em uma única célula de acessibilidade cujo rótulo carrega o resumo completo e todos os seus contadores ("57 回复。18 喜欢。592 次查看") — não há botões filhos por controle para corresponder, e as células de linha só aparecem em um snapshot profundo. Estas duas ferramentas expõem essa estrutura como linhas e agem dentro de uma linha.

| Ferramenta | O que ela faz | Parâmetros principais |
| --- | --- | --- |
| `ios_sim_ui_rows` | Lê as linhas visíveis de lista/feed do app em primeiro plano como linhas em vez de uma árvore crua: cada linha reporta seu índice, frame em pontos, o rótulo agregado e os contadores interpretados a partir desse rótulo (número + token de classificador, ex. `57 回复` → 回复=57, 中文 ou inglês — nenhum vocabulário de app fixo no código). As linhas só aparecem em um snapshot profundo: em um telefone, o `max_depth` padrão é 60, custando ~15–25 s / ~0.5 MB por chamada (o WDA atende requisições serialmente) — mantenha os observadores baratos (`ios_sim_find_text` / `ios_sim_ui_tree`) primeiro. Os contadores são interpretados heuristicamente e as chaves fazem ida e volta: passe uma chave exatamente como listada para `ios_sim_tap_row.expect_count`. Quando nenhuma linha é encontrada, o resultado diz o porquê (profundidade rasa demais / não é uma tela de lista / genuinamente nenhuma informação de acessibilidade após uma leitura profunda) — uma leitura rasa nunca é reportada como "o app não tem informação de acessibilidade"; linhas fora da tela são excluídas e contadas como `omittedOffscreen`. | `udid` (opcional), `max_depth` (somente em telefone; padrão 60) |
| `ios_sim_tap_row` | Toca em uma posição relativa dentro de uma linha visível de lista (reportada por `ios_sim_ui_rows`: índice baseado em 0; x/y como frações do frame daquela linha — 0 = borda esquerda/superior, 1 = direita/inferior, padrão 0.5 = centro) em um simulador (AXe) ou em um telefone conectado via USB (WebDriverAgent). O frame da linha vem de uma leitura NOVA da árvore, então nenhuma coordenada absoluta de tela é adivinhada; um índice fora do intervalo FALHA (nunca faz clamping). Trava de segurança: com `expect_count={key,delta}`, a ferramenta verifica a ação relendo o rótulo da linha e checando que o contador mudou exatamente +1/−1 (`countCheck.verified`); se a chave não estiver entre os contadores interpretados da linha, o toque é RECUSADO antes de acontecer — um toque em dispositivo real nunca é uma sondagem. Sem `expect_count`, o toque ainda acontece (uma posição relativa explícita à linha É a identificação), mas nada é verificado. | `udid` (opcional), `index` (obrigatório), `x`, `y` (frações 0..1), `max_depth`, `expect_count` (`{key, delta}`) |

### Ferramentas de OCR (Vision)

| Ferramenta | O que ela faz | Parâmetros principais |
| --- | --- | --- |
| `ios_sim_find_text` | Faz OCR da tela ATUAL de um simulador iniciado ou de um telefone conectado via USB com o helper Vision compilado pelo plugin (reconhecimento preciso, zh-Hans + en-US, compilado com `swiftc` no primeiro uso em `~/Library/Caches/dsh-ios/bin/ocr`). Use quando a árvore de acessibilidade estiver vazia ou degenerada, para texto renderizado como gráfico (contagens de badges, preços embutidos em imagens) ou para verificar de forma independente o que está na tela. Captura uma nova tela e retorna `{device, size, items:[{text, confidence, rect}]}` — os rects são caixas em pontos do dispositivo (origem no canto superior esquerdo), ordenados por confiança, limitados a ~40 KB (`truncated` descarta a cauda de menor confiança; restrinja com `query` ou aumente `min_confidence`). | `udid` (opcional), `query` (substring sem distinção de maiúsculas/minúsculas), `min_confidence` (padrão 0.3) |
| `ios_sim_tap_text` | Faz OCR da tela ATUAL e toca o centro da melhor correspondência de texto — as mesmas regras de exata → contém sem distinção de maiúsculas/minúsculas → lista de candidatos ambíguos do `ios_sim_tap_element`, para texto que a árvore de acessibilidade não consegue ver (apps sem a11y, contagens de badges, texto embutido em imagens). Em um telefone, o toque cai em pontos absolutos do dispositivo através do WebDriverAgent; no simulador em fluxo, é enviado normalizado através do controle do serve-sim (execute `ios_sim_boot` primeiro). Após ~300 ms, uma nova captura de tela mostra o efeito; passe `expect_text` / `expect_gone` e o toque mais sua verificação viram uma única ida e volta (`expected.matched`). Em um dispositivo REAL, todo toque tem consequências reais — nunca toque um controle não identificado para descobrir o que ele faz. | `udid` (opcional), `query` (obrigatório), `min_confidence`, `expect_text`, `expect_gone` |

### Ferramenta de logs

| Ferramenta | O que ela faz | Parâmetros principais |
| --- | --- | --- |
| `ios_sim_logs` | Lê o que um app de simulador imprime, a partir do log unificado do dispositivo: `snapshot` (`log show --last <duration>`, padrão 2m) ou `follow` (captura ao vivo limitada por `duration_seconds`, padrão 10, máximo 60 — nunca um fluxo que fica pendurado). A saída é limitada a ~300 linhas / 30 KB com uma dica de restrição. | `udid` (opcional), `mode` (`snapshot`/`follow`), `duration`, `duration_seconds`, `bundle_id`, `predicate` (NSPredicate cru, sobrescreve `bundle_id`), `level` (`default`/`info`/`debug`), `grep` |

### Ferramenta de preview

| Ferramenta | O que ela faz | Parâmetros principais |
| --- | --- | --- |
| `ios_sim_preview` | Hot reload de previews SwiftUI, ao vivo no simulador: `start` (padrão) valida o pacote, gera um app host descartável no cache do plugin (nunca dentro do seu pacote), compila o pacote como uma dylib para o simulador, instala + inicia o host e observa as fontes — cada edição recompila e aplica a quente sem relançar (~2–5 s). Erros de compilador mantêm o último preview bom e aparecem via `status`; uma sessão por vez. | `packagePath` (obrigatório para `start`), `udid`, `action` (`start`/`status`/`stop`), `previewFilter` (substring sem distinção de maiúsculas/minúsculas sobre os nomes dos previews) |

### Ferramentas de depuração

| Ferramenta | O que ela faz | Parâmetros principais |
| --- | --- | --- |
| `ios_sim_processes` | Lista os processos de app em execução de um simulador a partir do próprio launchd dele (pid visível no host, nome, bundle id) — a fonte de pid para backtrace/leaks; um udid de dispositivo físico lista os processos do telefone via devicectl. | `udid` (opcional), `filter` (substring sem distinção de maiúsculas/minúsculas sobre nome/bundle id) |
| `ios_sim_backtrace` | LLDB em lote de uma única vez (attach → thread backtrace → detach, nunca interativo); saída limitada a ~200 linhas, thread principal primeiro, alvo sempre verificado como retomado. Quando o macOS nega o attach (Modo de Desenvolvedor desligado), degrada para o motor `sample` não suspensivo do Xcode e reporta a dica de habilitação. Somente simuladores — dispositivos físicos são rejeitados com o motivo. | `udid` (opcional), `pid` / `bundle_id`, `all_threads` (padrão true) |
| `ios_sim_leaks` | Analisa vazamentos com a ferramenta `leaks` do Xcode: `summary` (contagem de vazamentos, total de bytes vazados, top ~30 tipos) ou `memgraph` (um artefato `.memgraph` para abrir no Xcode Instruments, nunca interpretado aqui). O app é suspenso durante a varredura e sempre retomado. Somente simuladores. | `udid` (opcional), `pid` / `bundle_id`, `mode` (`summary`/`memgraph`) |
| `ios_sim_app_info` | Fatos do app instalado: caminho do bundle do app, contêiner de dados gravável e valores do Info.plist — via `simctl appinfo` (com fallback `get_app_container`) em um simulador, via `devicectl` em um telefone conectado via USB; `installed: false` mais uma `note` apontando para `ios_sim_list_apps` para apps ausentes. | `udid` (opcional), `bundle_id` (obrigatório) |

## Superfícies de exibição

- **Painel lateral — “iOS 模拟器”.** A visão ao vivo fica em um painel persistente do lado direito (um dock fixo que empurra a conversa para o lado, ou um overlay centralizado em viewports estreitas). Ele renderiza o fluxo MJPEG ao vivo e aceita clique-para-tocar e arrasto-para-gesto diretamente no vídeo, com uma barra de ícones (Home, captura de tela, girar, atualizar) cujos botões têm tooltips ao passar o mouse. Os controles de tamanho oferecem **适应** (ajustar à largura do painel), **50–125%** de zoom da largura lógica do dispositivo e predefinições **S / M / L** que dimensionam o lado curto do dispositivo (largura em retrato; em paisagem, a escala mantém o tamanho físico do dispositivo). Os estilos de moldura são **无框 / 边框 / 真机框** (sem moldura / bezel / casca realista de dispositivo) com raio de canto proporcional. Quando o dispositivo gira para paisagem, o painel se alarga automaticamente até um tamanho confortável e restaura sua largura quando volta — um arrasto manual durante o período sempre vence. A alça na borda esquerda arrasta o painel para mais largo/mais estreito (máx. 960 px; duplo clique restaura a largura padrão). Quando um iPhone conectado via USB é o alvo do fluxo, o mesmo painel mostra o fluxo MJPEG do WebDriverAgent do telefone com os mesmos controles.
- **Cards compactos na conversa.** Resultados de ferramentas são renderizados como cards de uma linha, sem imagens inline: o título unificado **“iOS 模拟器”**, um sub-rótulo de ação (Boot / Screenshot / Interact / Build &amp; Run / Start WDA), o nome do dispositivo, um badge de status e uma dica de “abrir na barra lateral”. Clicar na linha abre o painel; cliques em botões, links ou no próprio frame ao vivo nunca o acionam.
- **Cápsula de status acima do campo de mensagem.** Enquanto o painel está fechado e um fluxo está online, uma pequena pílula com ponto verde (`<dispositivo> · 实时`) aparece acima do campo de mensagem e abre o painel quando clicada. Ela é limitada à sessão: renderiza e faz polling somente enquanto a conversa atual tem resultados de simulador montados, e para quando você troca para uma sessão sem eles.
- **Modo padrão e Modo de Código.** Sessões padrão usam o `presentationMeta` projetado pelo host. Despachos aninhados do Modo de Código (PTC) nunca carregam meta, então o cliente reconstrói o meta idêntico a partir do JSON de resultado durável — o painel, os cards e a cápsula funcionam nos dois modos.

## Segurança

- O navegador nunca fala com a porta do serve-sim. Cada byte atravessa a origem do webserver do DSH por rotas `/_dsh/dsh-ios/*` do plugin: `/stream/<token>` (proxy MJPEG), `/screenshot/<token>` (PNG em cache), `/ws?token=…` (relay de controle HID), mais os endpoints `/grant`, `/capture` e `/status`.
- Os tokens são capabilities HMAC-SHA256 (`base64url(payload).base64url(mac)`) que expiram em até 10 minutos, assinadas com uma chave por home do DSH (`<DSH_HOME>/cache/dsh-ios/stream-access.key`, 0600, criada atomicamente).
- Toda rota aplica uma proteção de transporte loopback/confiável antes de qualquer capability ser consultada: endereço de par em loopback, `Host` de loopback (DNS rebinding rejeitado) e verificações de Fetch-Metadata/Origin. A rota de captura de tela serve apenas arquivos dentro do diretório de cache do plugin (links simbólicos recusados, contenção por `realpath`).
- O serve-sim roda como um filho em primeiro plano somente em loopback, em uma faixa de portas dedicada (3181–3244), de modo que um serve-sim do próprio usuário na porta 3100 nunca é tocado; `--host` nunca é usado..
- **Adoção/reconquista de órfãos** — se um host DSH anterior foi morto de forma não graciosa e seu helper serve-sim sobreviveu, o mesmo dispositivo é adotado (o handshake do órfão é autoritativo); um helper obsoleto ocupando um slot de um dispositivo diferente é reconquistado via `serve-sim -k` e relançado uma vez.
- **Keep-alive + parada ociosa** — um fluxo que travou reinicia em segundo plano (atraso de ~5 s); com zero consumidores, o fluxo para automaticamente após 5 minutos. Paradas intencionais nunca são combatidas. (O runner de dispositivo real é isento da coleta ociosa de propósito: reiniciá-lo custa uma recompilação de vários minutos com `xcodebuild`.)

## Requisitos

- **macOS com Xcode completo** — não apenas Command Line Tools. `xcodebuild`, `xcrun simctl` e os runtimes do simulador vêm todos com o Xcode.
- **Pelo menos um runtime do Simulador de iOS** instalado no Xcode.
- **DSH ≥ 0.1.0-rc.6 com o bundle web** para o painel. Perfis headless também funcionam: as 21 ferramentas operam normalmente, apenas sem a visão ao vivo.
- **Hosts não macOS**: o plugin carrega e as 21 ferramentas são registradas, mas cada chamada retorna um erro explicativo (`iOS Simulator requires macOS with Xcode …`).
- **serve-sim** vem como dependência npm deste plugin, então ele resolve localmente em instalações reais; o fallback `npx -y serve-sim` cobre árvores de desenvolvimento (o primeiro uso precisa de rede).
- **AXe** (opcional — somente as ferramentas baseadas em AXe precisam dele: `ios_sim_ui_tree` / `ios_sim_tap_element`, mais `ios_sim_ui_rows` / `ios_sim_tap_row` em um simulador): `brew install cameroncooke/axe/axe`, ou deixe o plugin baixar automaticamente a versão fixada (v1.8.0, SHA-256 verificado) em `~/Library/Caches/dsh-ios/bin`. `DSH_IOS_AXE_BIN` sobrescreve a resolução; `DSH_IOS_AXE_OFFLINE=1` desativa o download.
- **Vision OCR** (opcional — somente `ios_sim_find_text` / `ios_sim_tap_text` precisam dele): o plugin compila seu `assets/ocr.swift` embutido com `swiftc` no primeiro uso em `~/Library/Caches/dsh-ios/bin/ocr` (reconhecimento zh-Hans + en-US).
- **lldb attach** precisa do Modo de Desenvolvedor do macOS: execute `sudo DevToolsSecurity -enable` uma vez. Até lá, `ios_sim_backtrace` usa o motor `sample` do Xcode (não suspensivo) e `ios_sim_leaks` degrada com a dica de habilitação.. A primeira compilação do WDA instala um WebDriverAgentRunner assinado: confie no certificado dele no dispositivo quando solicitado e execute `ios_real_start_wda` novamente quando o perfil de assinatura de equipe gratuita expirar (validade de 7 dias).

## Instalar no DSH

```sh
dsh plugin --profile web add @zseven-w/dsh-ios@latest
dsh web
```

> **nota rc** — `0.1.0-rc.1` ainda não foi publicado no npm. Até lá, instale o tarball empacotado:
>
> ```sh
> npm pack                                   # in this repository → dsh-ios-0.1.0-rc.1.tgz
> dsh plugin --profile web add /path/to/dsh-ios-0.1.0-rc.1.tgz
> dsh web
> ```

## Início rápido

Uma primeira conversa típica:

1. **Descubra dispositivos** — “Liste os simuladores disponíveis.” → `ios_sim_devices`.
2. **Inicie** — “Inicie o iPhone 17 Pro.” → `ios_sim_boot`. O fluxo começa e o **painel “iOS 模拟器”** abre: o dispositivo fica ao vivo na barra lateral. (Clique em qualquer linha de card de simulador, ou na pílula de status acima do campo de mensagem, para reabri-lo.)
3. **Toque no vídeo** — toque ou arraste diretamente no painel; ou deixe o agente controlar a interface: “Abra Ajustes e toque em Geral.” → `ios_sim_interact` (ou `ios_sim_ui_tree` + `ios_sim_tap_element` para toques por identidade; `ios_sim_find_text` + `ios_sim_tap_text` para toques por texto; `ios_sim_ui_rows` + `ios_sim_tap_row` para apps de lista/feed).
4. **Compile &amp; execute seu app** — “Compile e execute /path/to/MyApp.xcodeproj.” → `ios_sim_build_run`. Uma compilação completa leva minutos; quando terminar, o app inicia no simulador e você o assiste ao vivo no painel.
5. **Hot reload de previews** — “Mostre os previews SwiftUI de /path/to/MyPackage.” → `ios_sim_preview start`. Edite um arquivo de origem e o preview é aplicado a quente no simulador em execução em ~2–5 s — sem relançar.
6. **Controle um iPhone real** — conecte o telefone via USB (cabo de dados), desbloqueie-o e diga “Inicie o WebDriverAgent no telefone.” → `ios_real_start_wda`. O painel muda para o fluxo ao vivo do telefone e todas as ferramentas aceitam o udid do `realDevices` dele; quando uma chamada falha, leia o motivo codificado no status do painel (`device-locked`, `cert-untrusted`, `profile-expired`, `tunnel-failed`, `device-unplugged`).

## Solução de problemas

- **O backtrace usa `sample` em vez de lldb, ou o leaks reclama de inspeção restrita** — o Modo de Desenvolvedor do macOS está desligado. Execute `sudo DevToolsSecurity -enable` uma vez e tente novamente. As ferramentas degradam de forma limpa até lá: `ios_sim_backtrace` cai para o `sample` do Xcode (simbolizado, não suspensivo) e `ios_sim_leaks` reporta a dica de habilitação.
- **`ios_sim_ui_tree` / `ios_sim_tap_element` precisam do AXe** — instale com `brew install cameroncooke/axe/axe`, ou deixe o plugin baixar a versão fixada no primeiro uso (precisa de rede para o github.com). A mensagem de erro sempre traz a dica de instalação completa; `DSH_IOS_AXE_BIN=/path/to/axe` sobrescreve a resolução. As ferramentas de linha (`ios_sim_ui_rows` / `ios_sim_tap_row`) também precisam do AXe em um simulador.
- **`ios_sim_find_text` / `ios_sim_tap_text` reportam que o helper de OCR está ausente** — o primeiro uso compila o `assets/ocr.swift` embutido com `swiftc` (precisa do Xcode) em `~/Library/Caches/dsh-ios/bin/ocr`; o erro traz o caminho exato e a dica.
- **`ios_sim_ui_rows` não encontra linhas** — o resultado diz o porquê: profundidade rasa demais (aumente `max_depth`; em um telefone, cada snapshot mais profundo custa ~15–25 s), não é uma tela de lista, ou genuinamente nenhuma informação de acessibilidade após uma leitura profunda. Uma leitura rasa nunca é reportada erroneamente como acessibilidade ausente.
- **`ios_sim_leaks` em simuladores iOS 26.2** — em runtimes iOS 26.2, o `leaks` do Xcode pode falhar ao inspecionar processos do simulador com diagnósticos fatais como `Failed to get DYLD info` ou erros de minimal-corpse, mesmo com o Modo de Desenvolvedor ativado. A ferramenta degrada de forma limpa: você recebe o diagnóstico cru, o alvo sempre é verificado como retomado e nada fica pendurado. Não há correção do lado do plugin — quando isso acontecer, tente `mode: "memgraph"` ou um runtime diferente..
- **O fluxo para sozinho** — isso é a política de ociosidade, não uma falha: com zero consumidores (painel fechado, nenhum card montado, nenhuma rota ativa), o fluxo para após 5 minutos e reinicia na próxima chamada de ferramenta ou abertura do painel. Um fluxo que travou reinicia em segundo plano em ~5 segundos.

## Desenvolvimento

```sh
pnpm install
pnpm run build      # host tsc + client bundle → lib/
pnpm run typecheck
```

Os smoke tests de `scripts/` exercitam o `lib/` compilado (somente macOS para as partes que iniciam um simulador ou falam com um telefone conectado via USB; defina `DSH_IOS_SMOKE_SKIP_SIM=1` para pular essas partes):

| Script | O que cobre |
| --- | --- |
| `node scripts/dev-smoke.mjs` | Host do simulador: resolução de binários, inicialização do fluxo, controle, keep-alive, dispose. |
| `node scripts/dev-tools-smoke.mjs [--full-build]` | As ferramentas principais contra um simulador real (mais uma compilação real com `--full-build`). |
| `node scripts/dev-routes-smoke.mjs` | Rotas web assinadas: grant, proxy de fluxo, captura de tela, relay ws, proteções, expiração. |
| `node scripts/dev-card-smoke.mjs` | Cards do cliente: SSR estático (sem `<img>`), contrato de status/capture, parte de rede quase ao vivo. |
| `node scripts/dev-panel-smoke.mjs` | Componentes do painel, modos de tamanho, estilos de moldura, lógica de dock/acionador/cápsula (somente estático). |
| `node scripts/dev-logs-smoke.mjs` | `ios_sim_logs` snapshot/follow, filtros, limites, coleta de processos. |
| `node scripts/dev-uitree-smoke.mjs` | Ferramentas de árvore de UI: pipeline de resolução/download do AXe, seletores, árvore + toque em simulador real. |
| `node scripts/dev-debug-smoke.mjs` | Ferramentas de depuração: processos, backtrace (lldb + sample), vazamentos, informações do app. |
| `node scripts/dev-preview-smoke.mjs` | Hot reload de previews: iniciar, editar → aplicar a quente sem relançar, recuperação de erro, parar. |
| `node scripts/dev-orphan-smoke.mjs` | Adoção/reconquista de serve-sim órfão após uma morte não graciosa do host. |
| `node scripts/dev-ocr-smoke.mjs` | Ferramentas de OCR do Vision: resolução do helper, cache de compilação swiftc, pipeline de reconhecimento, roteamento de toque por texto. |
| `node scripts/dev-wda-smoke.mjs` | Host do WebDriverAgent: parsing de `ServerURLHere`, classificação de falhas, túneis, keep-alive (mockado; passada ao vivo opcional). |
| `node scripts/dev-realdevice-smoke.mjs` | `xcrun devicectl` contra um iPhone conectado via USB — os caminhos de código exatos que as ferramentas usam. |
| `node scripts/dev-realstart-smoke.mjs` | A rota `/real-start`: proteção, recusas codificadas, gating de compilação/inicialização (estático). |
| `node scripts/dev-realtools-smoke.mjs` | Backends de dispositivo real de `ios_sim_screenshot` / `ios_sim_interact` / `ios_sim_ui_tree` / `ios_sim_tap_element` mais `ios_real_start_wda`. |

## Créditos &amp; Licença

- [serve-sim](https://github.com/EvanBacon/serve-sim) — Evan Bacon — o motor de streaming do simulador (Apache-2.0; dependência de runtime embutida).
- [AXe](https://github.com/cameroncooke/AXe) — Cameron Cooke — a CLI de acessibilidade por trás das ferramentas de árvore de UI (MIT).
- [WebDriverAgent](https://github.com/appium/WebDriverAgent) — o servidor WebDriver que o plugin compila e inicia em dispositivos reais (licenciado sob BSD).
- Arquitetura inspirada no plugin “Build iOS Apps” do Codex; o motor de preview SwiftUI é uma reimplementação clean-room da abordagem documentada publicamente — nenhum código do Codex foi copiado.
- Veja [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) para os avisos completos.

**Licença**: MIT

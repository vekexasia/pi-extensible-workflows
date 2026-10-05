# Semantic Map: completamento Windows/Linux e preparazione del deploy

## Stato, mandato e fonti

**Stato: piano da eseguire. Non attesta fix implementati, gate verdi o deploy effettuato.**

Decisioni del proprietario, successive al primo workflow SMART E4:

1. Il branch deve supportare **Windows nativo**, anche se la base ufficiale è sviluppata su Linux. Una suite verde soltanto su Linux o attraverso wrapper temporanei non chiude il requisito Windows.
2. È scelta l'opzione **A: implementare gli URL versionati**, come nel requisito originale. Non è approvata la deroga «URL stabili + no-store».
3. Il mandato iniziale era scrivere il piano di completamento, includendo i fix e il percorso di deploy; questo documento non attesta che siano stati eseguiti.
4. Priorità successivamente concordata: **completare prima la versione attuale e consegnare almeno una prova visibile e riproducibile dei risultati in Trajectory; soltanto dopo passare al piano enhanced**. Il presente aggiornamento documenta tale sequenza, non esegue fix, test runtime o deploy.

Baseline osservata: branch `feat/trajectory-archify-v5.17.0`, HEAD `90474fb` (`feat(trajectory): package and serve semantic map`). Il proprietario ha confermato di avere eseguito i push dall'altra sessione. Esiste già una modifica locale al ledger: preservarla. Prima dell'esecuzione rilevare di nuovo HEAD e working tree, senza assumere che questa fotografia sia rimasta invariata.

Fonti e precedenza:

- [Piano funzionale](trajectory-archify-semantic-map.md), in particolare §§3, 6, 8, 9 e 12.
- [Addendum sulla base ufficiale](trajectory-archify-upstream-baseline.md): Gantt e Prism restano, Mermaid non esiste nella base e non va reintrodotto.
- [Ledger ed evidenze E0–E4](trajectory-archify-implementation.md): conserva risultati storici e fallimenti, non sostituisce i requisiti.
- [Piano enhanced](trajectory-archify-enhanced.md): sviluppo successivo alla baseline completata e alla prova visibile V0-D qui definita. Non anticipare layout gerarchico, rimozione 16/8/16, paging storico o nuovi RPC nella chiusura corrente.
- [Verifica contributor](../developers.html#evaluation), [AGENTS.md](../../AGENTS.md), [RELEASING.md](../../RELEASING.md).

Questo piano supera le precedenti limitazioni E4 che escludevano i fix Windows dal perimetro. Corregge anche l'affermazione «non esistono budget»: il piano originale contiene già obiettivi iniziali di latenza, peso e stabilità. Rimane da rendere riproducibile la misura del rumore heap, non da chiedere nuovamente una decisione sugli URL o sul peso raw attuale.

## Risultato osservabile e confini

Su Windows nativo un utente deve poter installare il candidato, avviare CLI/Pi/Trajectory, aprire Semantic Map, ricevere aggiornamenti e navigare nei dettagli, chiuderla senza attività residua, aggiornare il package senza mescolare build e tornare alla versione precedente in modo controllato. Gli stessi contratti devono continuare a funzionare su Linux.

- Build, test e packaging dalla root devono funzionare da PowerShell/cmd con Node/npm, **senza dipendenza obbligatoria da Bash/WSL**. Git resta necessario per i flussi worktree; `gh` resta opzionale per lo share reale.
- Copertura runtime: launcher usati da CLI, workflow e subagent; persistenza/path; lifecycle processi; Trajectory HTTP/WebSocket/browser; export. Non basta rendere portabili solo i test.
- Nessuna nuova dipendenza npm o browser framework, nessun cambio di provider/modello, nessun servizio aggiuntivo, nessun refactor generale estraneo ai difetti riprodotti. Usare Node built-in e dipendenze già dichiarate.
- Identità filesystem sempre tramite `packages/core/src/paths.ts`. Distinguere path fisici, ID strutturali e URL; nessun nuovo confronto locale `resolve/realpath` e nessuna conversione indiscriminata in lowercase.
- Preservare sandbox opaque, CSP, proiezione privacy, limiti, coda bounded, Gantt, Prism, transcript ed export live-only. Nessun nuovo socket o datastore per la mappa.
- Herdr live resta un'integrazione opzionale con prerequisiti reali; non fingere un ambiente Herdr né dichiarare testato il relativo host Windows. I test deterministici dell'integrazione e il suo comportamento quando assente restano obbligatori.
- Merge, push, tag, pubblicazione npm, deploy della documentazione, installazione nel profilo Pi personale e cambi di permessi richiedono approvazione separata. Non cambiare Developer Mode o privilegi Windows per aggirare test falliti.

## Sequenza, responsabilità e registro dei gate

Un solo integratore modifica e verifica; ricognizione o review possono essere delegate in sola lettura. Nessun writer concorrente nella stessa working tree. Se il proprietario aggiorna il branch da un'altra sessione, registrare il nuovo stato e ripetere i gate invalidati; non attribuire al candidato precedente risultati sul candidato nuovo.

Sequenza di integrazione: `W0 → W1 → W2 → W3 → W4 → W5 → W6 → W7 → W8 → W9`.

W3 e W4 hanno cause distinte, ma toccano entrambi il server e vanno integrati in sequenza. Le misure browser/heap non devono concorrere con build o altre suite. Ogni fase consegna diff circoscritto, test e log; un fallimento ripetuto deve produrre diagnosi, non retry invariati.

| Gate | Chiusura richiesta |
| --- | --- |
| G1 — toolchain Windows | Build/test/packaging nativi senza script POSIX o wrapper esterni |
| G2 — runtime Windows | CLI, processi, path, persistenza e stub portabili, con prove dei percorsi reali |
| G3 — framing | Frame validi accorpati o spezzati accettati; oversized e input invalidi respinti |
| G4 — identità build | Tre URL versionati, nessuna risposta di build diversa, upgrade/server già attivo verificati |
| G5 — browser | Live, sicurezza, lifecycle, p95, 50 cicli e 10 minuti verificati |
| V0-D — prova visibile | Scenario riproducibile, risultato apribile localmente, test e immagini del candidato, limiti e riscontro utente documentati; non sostituisce G1–G7 |
| G6 — distribuzione | Tre tarball verificati, consumer installato, CLI/Pi discovery, audit |
| G7 — matrice finale | Check/package/acceptance verdi Windows e Linux; documentazione coerente |
| G8 — deploy | Destinazione/versione/approvazioni definite, smoke e rollback del candidato esatto |

## W0 — Baseline riproducibile e inventario dei fallimenti

**Output:** inventario per causa e macchina, prima di cambiare comportamenti.

1. Registrare HEAD, diff, untracked, Node/npm, OS, browser e configurazione npm. Preservare i cambi E3/E4 e i log precedenti; non riavviare gli spike E0 già conclusi.
2. Usare un checkout/copia di verifica contenente anche le modifiche non committate. Non usare soltanto un archivio di HEAD se il candidato comprende un diff locale. `npm ci` dalle sole dipendenze dichiarate; nessun lockfile alterato per comodità.
3. Classificare i fallimenti per causa: shell/process launch, lint, fixture, isolamento configurazioni, path/symlink, framing, regressione del prodotto. Il numero storico di 38 fallimenti non è una checklist immutabile né prova che siano tutti ambientali.
4. Per ogni causa registrare comando minimo, errore, entrypoint, owner e regressione che fallisce prima del fix. Individuare i launcher condivisi prima di aggiungere helper duplicati.
5. Isolare i test in home/agent/temp dedicati per processo, senza modificare o cancellare configurazioni personali e senza copiare credenziali nei log.

**Scope:** inizialmente sola lettura; registro nel ledger. Espansioni runtime successive soltanto sui caller effettivamente coinvolti dalle riproduzioni.

**Accettazione:** esiste una mappa errore → causa → file → prova; i risultati storici non vengono spacciati per rerun sul candidato.

## W1 — Toolchain nativa e lint

**Scope principale:** `package.json`, manifest dei tre workspace, `scripts/`, `eslint.config.js`, relativi test di layout/build.

1. Sostituire gli script POSIX necessari a build/test/acceptance (`rm`, `cp`, `find`, `xargs`, `mktemp`, `trap`, `env -u`, assegnazioni inline e glob shell) con entrypoint Node piccoli e condivisi. Conservare i nomi pubblici dei comandi npm.
2. Usare le API fs per pulizia/copia limitate agli output posseduti dal build. Preservare ordine Semantic Map → TypeScript → bundle/copie, staging del changelog e layout dei package. Non cancellare genericamente `.tmp`, file utente o la working tree.
3. Il runner test deve mantenere discovery, esclusioni intenzionali, selezione `TEST_FILES`, timeout, concorrenza bounded, exit code e isolamento per file. Definire espansione glob e percorsi con spazi senza affidarsi a word splitting della shell. Gestire SIGINT/fallimenti e pulizia dei processi e directory propri.
4. Avviare tool Node tramite `process.execPath` e gli entrypoint risolti delle dipendenze, non mediante shebang POSIX. Per npm riutilizzare il launcher Node/npm effettivo e testare il percorso con spazi; non hardcodare una cartella utente e non ricorrere a `shell: true` globale.
5. Configurare il fixture browser `trajectory/test/fixtures/semantic-map-feasibility/live-profile.js` con lint JS e globali browser, senza regole type-aware. Tenere il lint del codice proprio; non escludere tutta la directory Semantic Map.
6. Conservare il comportamento eseguibile dei bin Linux nel packaging. Qualunque gestione del bit eseguibile deve restare circoscritta agli artefatti generati e al contratto già esistente, senza modificare ACL o permessi dell'host.

**Accettazione G1:** gli entrypoint npm si avviano da PowerShell/cmd e Linux senza `npm_config_script_shell=bash`; build e lint passano. I runner eseguono davvero i test selezionati, propagano un fallimento deliberato e non lasciano figli attivi. Nessun test scompare dalla discovery durante la migrazione.

## W2 — Launcher runtime, fixture, path e isolamento Windows

**Scope iniziale:** `packages/cli/src/cli.ts`, `packages/cli/src/pi-role.ts`, `packages/core/test/{harness,support}.ts`, `trajectory/test/trajectory-export.test.ts`, test CLI/subagent/runtime e moduli di avvio realmente individuati in W0. Leggere le API Pi pertinenti prima di modificarne l'integrazione; non cambiare i contratti SDK per adattarli ai test.

1. Correggere la causa condivisa delle invocazioni `spawn/execFile` incompatibili. Separare entrypoint JS noti, veri eseguibili e comandi shell intenzionali. Preservare argomenti, cwd, env, timeout, stdout/stderr, exit code e cancellazione.
2. Coprire executable/path con spazi e caratteri speciali, argomenti letterali, Unicode e PATH Windows case-insensitive/delimitato correttamente. Nessuna concatenazione shell di input utente. Se un wrapper `.cmd` è indispensabile, limitarne l'uso e provarne il quoting.
3. Sostituire gli stub `#!/bin/sh` di `gh`/Pi/editor con fixture eseguibili in entrambi i sistemi, senza sacrificare il test del confine processo. Se serve un seam di test, conservarne una prova separata sul vero launcher: non bypassare il processo per ottenere un verde fittizio.
4. Verificare export HTML, share con stub riuscito/fallito/inesistente; nessun upload reale o login richiesto dai test deterministici. Provare la distinzione tra eseguibile assente e processo avviato che fallisce.
5. Isolare `HOME`/profilo, `PI_CODING_AGENT_DIR`, temp e le variabili Herdr pertinenti. Non cancellare indiscriminatamente variabili necessarie al sistema o ai tool; il runner costruisce l'env del figlio e non altera il profilo del chiamante.
6. Correggere asserzioni POSIX solo dove verificano path fisici. Per identità riusare `paths.ts`; mantenere invariati ID strutturali e replay/persistence. Coprire drive, separatori, directory con spazi, case/alias effettivi del filesystem e junction con fixture appropriati.
7. Symlink: usare junction per i casi di alias di directory equivalenti su Windows. Per semantiche specifiche dei symlink non disponibili senza privilegi, rilevare la capability e dichiarare il singolo skip con ragione; non saltare intere suite di trust/path e non usare junction come finta prova di file-symlink. Eseguire la prova specifica in un runner che la supporti.
8. Provare cancellazione e chiusura dei processi lanciati su Windows; correggere eventuali processi figli superstiti senza terminare processi dell'utente o server non posseduti.

**Accettazione G2:** regressioni dei launcher e suite deterministiche real-session/CLI/subagent pertinenti verdi su Windows e Linux; avvio reale locale senza chiamate a provider a pagamento. Nessun `EFTYPE/ENOENT` dovuto a shebang o `.bin`; nessuna dipendenza dalle impostazioni personali. Ogni skip rimasto ha capability e copertura alternativa esplicite, non una giustificazione generica «Windows».

## W3 — Correzione del framing WebSocket

**Scope:** `packages/core/trajectory/src/server.ts`, `trajectory/test/trajectory-server.test.ts` e helper di test pertinenti.

1. Riprodurre in modo deterministico più frame validi in un'unica consegna e un frame suddiviso in più consegne, senza affidarsi al timing TCP locale.
2. Correggere `parseFrames`: il limite del singolo frame non deve diventare il limite della somma di frame completi ricevuti insieme. Consumare frame completi e limitare esplicitamente il residuo incompleto.
3. Evitare buffer/code illimitati e controllare la lunghezza dichiarata prima di allocazioni costose. Conservare controlli mask, opcode, control frames, lunghezze e chiusura su input invalido.
4. Testare attach+state accorpati, header/body frammentati nella consegna TCP, più frame consecutivi, frame realmente oversized, lunghezza dichiarata malevola e disconnessione. Non introdurre supporto a WebSocket continuation frames se fuori dal contratto attuale.
5. Rieseguire il caso `Trajectory rejects an oversized subagent transcript reply`, le protezioni transcript e il percorso publisher/browser reale.

**Accettazione G3:** i frame singolarmente validi non scompaiono per coalescing TCP; oversized e input malformati restano respinti; memoria/backpressure rimangono bounded. Vietati fix basati solo su aumento del limite o sleep nel test.

## W4 — URL versionati, aggiornamenti e coerenza dei byte

**Scope:** `scripts/build-semantic-map.mjs`, `trajectory/src/semantic-map-assets.ts`, `trajectory/src/semantic-map/{index,bridge,viewer}.ts`, `trajectory/src/{index,server}.ts`, ricetta di patch vendor strettamente necessaria, test route/lock/bridge/browser/package e verifier.

**Contratto proposto per l'implementazione:** tre nomi fisici invariati e query obbligatoria `v=<build-stamp>`:

```text
/semantic-map.html?v=<stamp>&embed=1&theme=dark
/semantic-map.js?v=<stamp>
/semantic-map.css?v=<stamp>
```

1. Generare i riferimenti parent → HTML → JS/CSS con lo stesso stamp. Normalizzare i placeholder prima del calcolo per evitare hash autoreferenziale; escludere output generati dalla ricorsione della build.
2. Solo GET sui tre path esatti dopo l'autorizzazione esistente. Versione assente, duplicata, malformata o diversa dalla build servibile: risposta di errore non cacheabile (404), mai fallback alla build corrente. Preservare i parametri UI previsti senza confonderli con la versione.
3. Conservare `Cache-Control: no-store` in V1 per parent, stato e asset: gli URL sono comunque versionati e non si introduce cache persistente su un'origine loopback riutilizzabile. Ottimizzare la cache non è un requisito di chiusura.
4. Un processo vecchio può leggere file nuovi dopo un aggiornamento in-place: **non basta confrontare la query con una costante importata all'avvio**. Convalidare lo stamp dei byte dell'asset già letto su richiesta rispetto a quello richiesto/atteso; se la build è incoerente o incompleta, fallire chiuso (503) senza servire contenuti misti. Nessun hashing/lettura eager dell'intero viewer all'attach.
5. Distinguere versione di protocollo e ID build nel bootstrap/ready. Un parent/child incompatibile deve produrre un errore visibile con recupero esplicito; niente dati del run inviati a un viewer non validato.
6. Testare con due build A/B: parent A + server B; processo server A con asset B sostituiti; aggiornamento mentre la tab è aperta e successiva riapertura; lock/health stale; riavvio controllato dal proprietario del server. Non uccidere processi di altre sessioni per fare passare il test.
7. Build offline ripetute identiche, sensibilità dello stamp a input pertinenti, coerenza LF/CRLF e dei risultati Windows/Linux con la stessa toolchain. Le tre copie canoniche distribuite restano una per tipo; non introdurre un quarto asset browser.

**Accettazione G4:** URL realmente legati alla build; una vecchia URL non restituisce byte nuovi; mismatch e upgrade sono provati nel browser e dal package installato. CSP/sandbox/export invariati. Aggiornare i test che oggi accettano `?build=ignored`.

## W5 — Browser, lifecycle, performance e fix residui

**Scope:** `trajectory/test/trajectory-browser.test.ts`, `semantic-map-browser.test.ts`, test adapter/bridge e soli moduli UI/renderer/bridge dimostrati difettosi. Usare Chrome/CDP esistente; nessuna nuova dipendenza.

### Prove obbligatorie

- Percorso reale publisher → WebSocket → parent → tab → iframe → selezione/dettaglio; run, focus agente e subagent; cambio scope/generazione, reconnect e transcript su richiesta.
- Regressioni di sicurezza: source/nonce/istanza/versione errati, payload/ID invalidi, XSS, privacy e assenza azioni workflow dal child. Il versionamento non sostituisce questi controlli.
- 10 warm-up seguiti da **50 cicli completi**, close-before-ready, close durante ACK/render, resize, hidden/visible, tastiera, tema/reduced-motion. Dopo close nessun frame/porta/callback attiva appartenente alla vecchia apertura e nessuna nuova richiesta avviata dal viewer; distinguere richieste già in volo prima della chiusura.
- **10 minuti reali di aggiornamenti** con la mappa aperta: cadenza ordinaria circa 1 Hz, campioni regolari, cambi di stato e prove di inserimento/rimozione. Burst/ACK lento separati per verificare massimo un invio attivo e uno snapshot pending sostituibile, senza backlog.
- Profilo end-to-end entro i limiti della proiezione realmente supportata. Prove separate al limite adapter/renderer (500 nodi/1.500 archi) e di truncation: non dichiarare che il parent trasmette quel volume se la sua proiezione è più piccola.
- Analizzare le richieste CSS duplicate con initiator/timestamp CDP e log server. Se dipendono dall'app, correggere il doppio caricamento; se sono speculative/cancellate dal browser, documentare la causa e i byte effettivi. Un test che accetta genericamente «almeno tre richieste» non chiude da solo questa indagine.

### Protocollo e criteri delle misure

| Misura | Protocollo | Criterio |
| --- | --- | --- |
| Primo caricamento | Almeno 50 aperture misurate, warm-up separato; click → primo snapshot applicato e rendering osservabile, non solo handshake ready; cache HTTP non riusata | p95 ≤ 1 s sul browser/hardware di riferimento documentato |
| Aggiornamento ordinario | Stato accettato dal parent → applicazione visibile; includere proiezione, attesa bridge e rendering; campioni nei 10 minuti | p95 ≤ 100 ms a cadenza ordinaria |
| Burst | Misurare anche stati sostituiti e tempo di convergenza dell'ultimo stato | Limite 4 invii/s e coda bounded; nessun cambio dell'origine temporale per nascondere la coda |
| Peso | Somma raw tre asset e byte HTTP; tarball/unpacked separati | Obiettivo 0,8–0,85 MB; oltre 1 MB richiede revisione esplicita |
| Lifecycle | Conteggio risorse e verifica dopo quiescenza | Zero contesti/frame/porte/timer attivi della mappa chiusa; nessuna callback obsoleta con effetti |
| Heap | GC controllato, campioni parent e iframe, confronto con controllo senza mappa | Nessuna crescita cumulativa attribuibile a risorse applicative trattenute; niente trend crescente persistente oltre il rumore di controllo |

Per heap: prima della nuova prova candidata misurare un controllo ripetuto senza mappa con identica strumentazione, fissare e registrare una tolleranza derivata dal rumore di quel controllo. Conservare campioni grezzi e rendere bounded anche i log/riferimenti dell'harness. Rilevare Resource Timing e oggetti CDP trattenuti separatamente; un'eventuale pulizia della strumentazione vale ugualmente per controllo e candidato e non deve cancellare riferimenti applicativi. Se la crescita persiste, analizzare snapshot/retaining paths e correggere la causa. Nessun leak dimostrato è accettabile solo perché sotto una soglia numerica; nessuna soglia può essere allargata dopo il fallimento per ottenere un verde.

Il floor attuale di 250 ms tra invii va considerato nelle misure: il target 100 ms riguarda la cadenza ordinaria, non tutti gli eventi di un burst coalesced. Se anche il percorso ordinario lo supera, correggere scheduling/costo oppure presentare una deviazione misurata; non ridefinire la misura come solo tempo del renderer.

**Accettazione G5:** suite browser obbligatoria senza skip su Windows e Linux; report con campioni/p95, risorse e rete, non sole medie o una singola apertura. Le condizioni non soddisfatte restano blocker tecnici, non richieste di approvazione generica delle misure precedenti.

## W5-D — Prova visibile della versione attuale (milestone V0-D)

**Scopo:** il proprietario deve poter vedere e provare ciò che è stato implementato, non ricevere soltanto conteggi di test o promesse sull'enhanced. Questa prova si aggiunge ai gate W5; non richiede pubblicazione, deploy pubblico, modifica del profilo personale o implementazione delle funzionalità enhanced.

### Scenario e sorgente dei dati

- Un piccolo workflow rappresentativo e ripetibile: indicativamente 3–6 agenti, due fasi, 6–12 tool call complessive, attività in corso, completamenti, un errore controllato e un risultato ispezionabile. Un retry può essere incluso se già supportato dal percorso provato. Restare entro i limiti correnti per la prova nominale, senza attribuire alla mappa capacità nuove.
- Generare lo scenario attraverso il runtime e la persistenza esistenti con transport/risposte deterministiche di test, oppure usare un run esistente espressamente scelto dal proprietario in sola lettura. Il caso deterministico non deve contattare provider a pagamento; dichiarare esattamente cosa è simulato.
- Il percorso nominale deve leggere i file del run e le sessioni mediante i loader reali e passare da publisher → WebSocket/server → UI → bridge → viewer. Non sostituirlo con un JSON inserito direttamente nel DOM o con soli messaggi WebSocket sintetici: le fixture attuali restano regressioni complementari, non la prova completa.
- Nessuna nuova strumentazione/persistenza per produrre una demo più ricca. Leggere struttura, tentativi, tool call e risultati già registrati; distinguere dati conservati da ciò che il reader/proiettore attuale rende visibile.
- Per le tool call, annotare l'attuale dipendenza dalla cache transcript: provare prima la mappa senza aver aperto il dettaglio, poi aprire un transcript e tornare alla mappa. Non precaricare di nascosto la cache per far sembrare completa la prima vista.

### Percorso da mostrare all'utente

1. Avviare il candidato in ambiente isolato; stampare URL loopback e istruzioni per aprirlo volontariamente. Il Gantt è la vista iniziale e la mappa non carica asset prima del clic.
2. Selezionare il run dello scenario e aprire Semantic Map: riconoscere i nodi realmente disponibili, il loro stato e l'indicazione di incompletezza.
3. Osservare almeno un aggiornamento di stato prodotto dal runtime deterministico; selezionare un agente e aprire il relativo dettaglio/transcript con il gesto effettivamente supportato.
4. Mostrare errore controllato e risultato registrato nell'inspector; confrontare entità/stati visibili con la fonte. Per fasi o relazioni che V0 non visualizza, indicare dove sono disponibili e che cosa manca nella mappa.
5. Tornare al Gantt, chiudere e riaprire la mappa senza effetti sul run. Verificare errori browser, connessione e comportamento di cleanup.
6. Annotare cosa succede con uno scenario aggiuntivo oltre il limite, per esempio più di 16 agenti: dichiarare che la vista è limitata, senza attribuire il taglio a perdita dei dati sul disco. Questa è documentazione della baseline, non prova dei carichi enhanced S/M/L.

### Test e materiale da consegnare

- **Test automatico browser reale** focalizzato, su Windows nativo, ripetibile anche su Linux: usare Chrome/CDP e profilo isolato; verificare scena, update, selezione, apertura del dettaglio e chiusura. Aggiungere la prova al runner pertinente, senza saltarla silenziosamente quando manca il browser richiesto.
- **Avvio manuale della stessa prova** con comando dalla root e istruzioni PowerShell/cmd/Linux. Un entrypoint dedicato, per esempio `scripts/demo-trajectory-semantic-map.mjs`, è solo un percorso proposto da implementare: non presentarlo come già disponibile. Riutilizzare harness/fixture comuni invece di creare una seconda UI dimostrativa.
- Modalità di ispezione mantiene vivi solo i processi propri fino a stop esplicito/Ctrl+C, stampa URL e modalità di arresto; niente auto-open del browser. La modalità test automatico chiude invece server e browser al termine. La prova non deve terminare subito e lasciare all'utente un URL già morto.
- Conservare screenshot reali di Gantt, mappa e dettaglio/risultato, più un breve walkthrough testuale; eventuale video è facoltativo. Non usare mockup enhanced come immagine della versione attuale.
- Cartella evidenze proposta: `.tmp/archify/current-demo/<candidate-id>/`, locale e ignorata. Il runner deve comunicare il percorso effettivo e mantenerla disponibile per la revisione; i dati sintetici possono essere rigenerati dal comando. Non dichiarare tali file visibili su GitHub e non eliminare le evidenze prima che il proprietario le abbia viste.
- Il dossier contiene: SHA più identificazione del diff se il candidato è dirty, build stamp, toolchain/OS/browser, comando, run/session ID, origine dei dati, pass/fail/skip, confronto atteso/osservato e limiti. Se si usa un tarball, aggiungere checksum; immagini/log devono riferirsi a quel candidato, non a un dist precedente.
- Istruzioni riproducibili e riepilogo risultati nel repository; sessioni, transcript sensibili e log grezzi non si pubblicano automaticamente. Lo screenshot statico non equivale all'export interattivo della mappa: V0 resta live-only.

### Confine della consegna e passaggio all'enhanced

| Stato | Evidenza richiesta |
| --- | --- |
| `V0-D PREVIEW AVAILABLE` | Prova nominale eseguibile e materiale visibile; qualunque gate tecnico aperto è elencato. Non significa E4 chiuso. |
| `CURRENT BASELINE COMPLETE` | G1–G7 superati, dossier W8 pronto e prova V0-D consegnata; nessuna deroga implicita a sicurezza/correttezza. |
| `ENHANCED NEXT` | Il proprietario ha visionato i risultati, il riscontro è nel ledger e il passaggio a H0 è confermato. Il deploy W9 non è necessario. |

Questi sono stati da raggiungere, **non esiti già ottenuti**. Registrare separatamente `prova pianificata`, `eseguita`, `consegnata`, `visionata` e `passaggio confermato`. Non chiedere all'utente di giudicare soltanto un log TAP o chiamare completata la versione perché un singolo test è verde.

Prima della prova, i test editor devono essere isolati e portabili: **nessuna apertura di VS Code o di `fake-editor.sh`/`failing-editor.sh` tramite associazioni Windows**. Non usare impostazioni o credenziali personali, non toccare workflow attivi e non fermare server altrui. I fix del perimetro corrente restano in W1–W5; layout/ricerca/storia enhanced restano nel piano successivo.

## W6 — Packaging e consumer realmente installato su Windows

**Scope:** `scripts/verify-packed-packages.mjs`, helper di processo W1/W2, test package/layout, manifest solo se necessari al contratto verificato.

1. Eliminare dal verifier la dipendenza da executable POSIX `.bin`, stub `sh` e PATH separato da `:`. Risolvere gli entrypoint JS per gli smoke programmatici; aggiungere smoke dei wrapper npm pubblici da PowerShell/cmd e shell Linux, così il test non nasconde un bin distribuito rotto.
2. Verificare npm pack/install e l'estrazione su entrambi gli OS; dichiarare i tool esterni necessari, senza installazioni globali implicite o wrapper ad hoc fuori repo. Non disabilitare prepack/postpack core: devono includere e poi pulire il changelog staged.
3. Produrre e installare tutti e tre i tarball in un consumer temporaneo isolato. Provare che `@piewf/cli` usa il core candidato, non una copia omonima già presente o scaricata dal registry.
4. Verificare una copia di ogni asset canonico, licenze, assenza fixture/vendor template duplicati, import/entrypoint/sourcemap appropriati. Aprire il server dal package installato e provare URL versionati, MIME/CSP/no-store e i casi A/B di W4.
5. Eseguire `piewf run --help`, `pi-role --help`, il percorso di launch con argomenti verificati, installazione locale/discovery Pi e audit. Nessuna chiamata LLM o pubblicazione reale per questi smoke.
6. Controllare cleanup dopo successo/fallimento/cancellazione: niente server figli, file staging o directory temporanee abbandonate. Conservare i tarball solo nella destinazione artefatti prevista, con checksum.

**Accettazione G6:** `npm run test:packages` termina con successo su Windows nativo e Linux senza wrappers esterni; tutti gli smoke successivi al consumer Semantic Map sono raggiunti. Errori registry/rete/audit restano visibili e non diventano skip silenziosi.

## W7 — Matrice CI e gate finali del candidato

**Scope:** `.github/workflows/check.yml`, guide contributor/Windows e comando browser/soak se separato. Nessun aumento di permessi CI.

- Promuovere Windows da solo test rename a piattaforma della suite completa; preservare la regressione atomic replacement.
- Matrice proposta: `windows-latest` e `ubuntu-latest`, Node `22.19.0` (minimo dichiarato) e `24`. Registrare npm effettivo; se il minimo dichiarato non è supportabile, non alzarlo di nascosto.
- Su ogni cella: `npm ci`, `npm run check`, `npm run test:packages`, `npm run acceptance`. Nessun `continue-on-error` per Windows o filtro che nasconda regressioni.
- Job browser/soak esplicito su entrambi gli OS, almeno Node 24: trovare un Chrome compatibile disponibile, configurare `PI_TRAJECTORY_CHROME`, fallire se manca anziché accettare test skipped. Adeguare timeout al test di 10 minuti, alla build e al cleanup; eseguire senza concorrenza che inquini le misure.
- Fare partire i controlli anche sul branch di lavoro o tramite dispatch read-only/PR: oggi i push al solo feature branch non attivano automaticamente `check.yml`. Avviare PR o cambiare protezioni del branch resta un'azione separata del proprietario.
- Archiviare log, inventario test pass/fail/skip, metriche e checksum del candidato. Gli skip Herdr live/provider sono quelli documentati dai relativi prerequisiti; non provano runtime esterni verificati.
- Identificare le prove per SHA e diff candidato. Per la chiusura usare il medesimo stato sorgente su entrambi gli OS; se un fix segue la verifica, ripetere i gate invalidati e infine quelli integrati.

**Accettazione G7:** intera matrice richiesta verde; nessun blocco Windows classificato semplicemente fuori scope. La review finale è unica e basata su diff/evidenze; finding concreti vengono risolti con regression test, senza review loop invariati.

## W8 — Documentazione, release candidate e prontezza al deploy

**Scope:** `README.md`, `docs/llm.md`, `docs/subagents.html`, `docs/developers.html`, `CHANGELOG.md`, ledger e documentazione di rilascio pertinente. Seguire i contratti esistenti invece di duplicare istruzioni API.

1. Documentare Windows nativo, tool/prerequisiti, comandi PowerShell/cmd, URL versionati, update/error recovery, limiti grafici/proiezione, export live-only e risultati di performance. Nessuna promessa di DAG completo o impatto nullo assoluto.
2. Aggiornare la matrice del ledger preservando la cronologia; segnare URL A deciso e Windows obbligatorio. Chiudere E4 soltanto con G1–G7 verdi e prove collegate.
3. Preparare un dossier candidato con SHA, toolchain, tre tarball e checksum, dipendenze/versioni, test su Windows/Linux, eventuali integrazioni esterne non esercitate e istruzioni di rollback. Includere la consegna V0-D: comando riproducibile, accesso al risultato, screenshot/walkthrough, dati attesi/osservati, limiti V0 e riscontro utente; riusarla come baseline prima/dopo nell'enhanced.
4. Eseguire i release check di `RELEASING.md` senza confondere `npm pack --dry-run` con un tarball reale e senza pubblicare. Non cambiare versione o lockfile durante i fix; un eventuale version bump approvato richiede ricostruzione e rivalidazione dei tarball finali.

**Uscita:** `READY FOR DEPLOY` significa candidato verificato e dossier completo, non già pubblicato. La prontezza tecnica non autorizza tag/push o modifica del profilo Pi dell'utente.

## W9 — Deploy approvato, smoke finale e rollback

Questo repository distribuisce package/CLI/estensioni; non è un'applicazione hosted. Prima di eseguire questa fase il proprietario deve scegliere **destinazione e canale**, non nuovamente Windows o URL A:

- **Installazione locale del candidato da tarball**, inizialmente in un profilo Pi isolato su Windows: percorso consigliato per validare il branch senza toccare registry pubblici. Il passaggio al profilo personale richiede consenso e inventario delle installazioni esistenti.
- **Release del fork su registry:** confermare nomi/scope, registry, credenziali/autorizzazioni, versione comune e dist-tag. I manifest e `publish.yml` usano ancora i nomi ufficiali `pi-extensible-workflows` e `@piewf/*`; avere un fork Git non autorizza a pubblicarli né a riusare `5.17.0` per byte diversi. Un cambio nomi/scope è una decisione di release separata, non implicita nei fix.
- **Documentazione pubblica:** soltanto se richiesta; non invocare automaticamente il workflow Pages come parte del test package.

### Procedura dopo approvazione

1. Registrare versione/canale precedente, provenienza degli artefatti e configurazione da preservare. Non cancellare run, sessioni, transcript o impostazioni; non cambiare formato persistito per questa feature.
2. Distribuire i tarball esatti del dossier. Se è prevista pubblicazione, rispettare versione condivisa e tag di `RELEASING.md`; verificare i gate del medesimo SHA su Windows e Linux prima del publish. Il workflow attuale pubblica core/CLI/Herdr e può essere attivato da `v*` o dispatch: non avviarlo come semplice prova.
3. Coordinare le sessioni attive e riavviare soltanto il server Trajectory posseduto quando necessario. Verificare il mismatch del vecchio server e il recupero documentato; non terminare automaticamente workflow in esecuzione.
4. Smoke sul consumer finale Windows: CLI/Pi discovery, Gantt predefinito, nessun caricamento mappa prima del clic, tre asset versionati, snapshot live, selezione/dettaglio, chiusura/riapertura, export statico e stop pulito. Ripetere smoke Linux sullo stesso artefatto; lo share reale richiede approvazione dell'upload.
5. In caso di regressione: interrompere la promozione, reinstallare l'artefatto precedente nel profilo autorizzato e riavviare solo processi posseduti. Se già pubblicato, nessun `unpublish` o spostamento di dist-tag senza ulteriore autorizzazione; preferire una correzione con nuova versione. Verificare il rollback prima in profilo isolato.
6. Registrare esito, destinazione, versioni e checksum effettivamente installati. Solo dopo lo smoke finale G8 diventa `DEPLOYED`.

## Checklist di consegna

- [ ] W0: baseline/fallimenti classificati e modifiche preesistenti preservate.
- [ ] W1–W2: toolchain e runtime Windows nativi, test isolati, Linux non regredito.
- [ ] W3: fix framing con regressioni positive/negative e limiti preservati.
- [ ] W4: URL A implementati e mismatch/upgrade riprodotti.
- [ ] W5: browser/sicurezza, p95, 50 cicli, 10 minuti, heap e duplicate CSS chiusi con evidenze.
- [ ] W6: verifier completo e consumer installati su Windows/Linux.
- [ ] W7: matrice finale verde sul candidato esatto, senza skip obbligatori.
- [ ] W8: documentazione, changelog e dossier candidato pronti; E4 chiuso solo allora.
- [ ] V0-D: prova visibile riproducibile consegnata con risultati/immagini e limiti; visione e riscontro del proprietario registrati prima del passaggio all'enhanced.
- [ ] W9: solo se richiesto, destinazione/versione/operazioni esterne approvate; deploy, smoke e rollback verificati. Non è un prerequisito per avviare l'enhanced dopo la baseline.

**Verifica di questo documento:** soltanto controlli documentali/diff durante la sua redazione. Nessun fix, test runtime aggiuntivo, workflow d'implementazione, commit, push o deploy è implicito nella creazione del piano.

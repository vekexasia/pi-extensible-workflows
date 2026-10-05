# Trajectory: integrare Archify Semantic Map sulla release ufficiale

## Stato e decisione

**Piano di implementazione; nessuna integrazione runtime eseguita in questo commit.**

- Repository: `GregBreak/pi-extensible-workflows`.
- Branch attivo: `feat/trajectory-archify-v5.17.0`.
- Base ufficiale aggiornata: **`v5.17.0`**, commit **`b86636786a097fedbcf64747579aa8f8ff59d1bb`**, coincidente con `vekexasia/pi-extensible-workflows:main` al controllo del 26 settembre 2026.
- Branch precedente conservato: `plan/trajectory-archify-semantic-map`, analisi originaria sul fork `f94fd0205c900768d7bace20e2d31bffa6a99849`.
- Indicazione aggiornata del proprietario: **eliminare Mermaid, mantenere solo Archify come viewer grafico**. Non aggiungere una terza visualizzazione né conservare Mermaid come fallback.
- Il **Gantt nativo rimane la vista principale e predefinita**. Archify è una scheda secondaria, `Semantic Map`, caricata esclusivamente su richiesta.
- Trajectory mantiene l'autorità sui dati live, sulla selezione e sulle azioni. La mappa è una proiezione effimera, non un secondo datastore.

### Aggiornamento vincolante della base

Su richiesta del proprietario, l'implementazione parte dalla release ufficiale **v5.17.0**, non dalla vecchia versione del fork. Dal vecchio branch è stato riportato **soltanto il commit documentale del piano**, nessun codice Mermaid.

**La base ufficiale non contiene Mermaid.** Le sezioni sotto che descrivono rimozioni e risparmi rispetto a Mermaid sono evidenza storica sul vecchio fork: NON sono operazioni da introdurre artificialmente sulla nuova base. La nuova integrazione deve mantenere l'assenza di Mermaid e aggiungere Archify come unico viewer semantico. Non copiare `index.html`, test o componenti runtime dalla vecchia versione.

Prevale l'addendum [Base ufficiale e differenze operative](trajectory-archify-upstream-baseline.md): richiede di preservare anche Prism e i nuovi test browser/CDP ufficiali, rivalutare il packaging con le sue due directory compilate di asset, ricalcolare il peso rispetto alla release ufficiale e adattare l'epic E3 all'integrazione, anziché alla rimozione di codice inesistente.

Nessuna integrazione runtime è stata eseguita in questo commit. Il workflow SMART precedente è stato fermato durante la discovery, prima di qualsiasi modifica ai sorgenti.

### Priorità confermata: progetto leggero e manutenzione contenuta

L'assenza di dipendenze npm è necessaria, ma non sufficiente: anche un grande viewer vendorizzato e modificato diventa un onere di aggiornamento. Il criterio di scelta è **minima superficie di codice da mantenere**, non massima quantità di funzioni Archify importate.

- V1 essenziale: rappresentazione live, pan/zoom, selezione, ricerca e dettagli. Nessun requisito di parità con ogni funzione del viewer completo.
- Non attivare story/guided views, motion recording, export avanzati o source-evidence esterno. Omettere il relativo codice soltanto se esiste una separazione pulita e riproducibile; non praticare rimozioni fragili solo per risparmiare byte.
- Il template da 775 KB è una baseline di fattibilità, non un minimo da includere obbligatoriamente. Un profilo Archify più piccolo è preferibile **se riduce anche la manutenzione**.
- Nessun fork generalista del motore grafico, framework di plugin o refactor trasversale di Trajectory per questa funzione. Le modifiche upstream devono essere localizzate, spiegabili e verificabili.
- F0 produce anche inventario delle patch locali, dipendenze fra capacità mantenute e prova di rigenerazione dagli input fissati. Se il lifecycle live richiede interventi distribuiti in molti moduli, il gate non passa senza una nuova decisione del proprietario.
- Aggiornamenti upstream manuali e intenzionali, revisione delle modifiche e rerun dei test; niente auto-update, dipendenze remote runtime o download durante l'installazione.

## 1. Riscontri sulla base originaria del fork (da rivalidare su v5.17.0)

| Area | Evidenza nella repository | Conseguenza |
| --- | --- | --- |
| UI | `packages/core/trajectory/src/assets/index.html`: Gantt nativo, pannelli Mermaid a livello run e agent, `acceptState`, `requestTranscript`, `setView` | Preservare Gantt, transcript, inspector, ricerca, selezione e navigazione. Eliminare solo il percorso grafico Mermaid. |
| Trasporto | `trajectory/src/server.ts`: `/ws`, snapshot `state`, RPC transcript/action, gestione publisher e backpressure | Nessun secondo WebSocket per la mappa e nessun nuovo protocollo di pubblicazione nel primo rilascio. |
| Frequenza live | `trajectory/src/index.ts`: polling publisher ogni 1.000 ms, deduplicazione dello stato | “Live” significa aggiornamento dopo gli snapshot ricevuti, non latenza inferiore a quella del publisher. |
| Dati | `packages/core/src/trajectory.ts`, `src/types.ts`: run, agent, scope, tentativi, tool call, metadata transcript e timing | Usare i dati esistenti. Non promettere una causalità completa che lo snapshot non contiene. |
| Limiti | Proiezioni bounded, `trajectory:truncated`, transcript caricati su richiesta e limitati, frame limitati | Esibire incompletezza e omissioni; non interpretare dati mancanti come successo o cancellazione. |
| Fingerprint | `trajectory/src/index.ts`: lettura/hash di server, HTML e Mermaid prima del riuso del server | Rimuovere Mermaid senza sostituirlo con la lettura eager dell'intero viewer Archify. |
| Export | `trajectory/src/export.ts`: asset inlined e `window.__PIEWF_STATIC__` | Aggiornare l'export senza introdurre richieste ad asset locali inesistenti. |
| Package | `packages/core/package.json`: copia degli asset in `dist`, pubblicazione anche dei sorgenti; Mermaid escluso dalla copia sorgente | Pubblicare una sola copia dei tre asset Archify, non sia `src` sia `dist`. |
| Test | Test Node/VM della UI, server, export, lock, package e Gantt | Riutilizzare la suite; aggiungere verifiche browser reali per iframe e lifecycle. |

### Archify verificato

Il candidato individuato è [tt-a1i/archify](https://github.com/tt-a1i/archify), alla revisione **`9e35d2b0b39b155553ba9fcfe0b4f2a5198dd993`**. Il template indica `2.17.0-dev.1`: è una base di valutazione, **non una scelta automatica di versione stabile**.

Fonti primarie, fissate alla revisione:

- [Template generato](https://github.com/tt-a1i/archify/blob/9e35d2b0b39b155553ba9fcfe0b4f2a5198dd993/archify/assets/template.html).
- [Contratti e sorgenti del viewer](https://github.com/tt-a1i/archify/blob/9e35d2b0b39b155553ba9fcfe0b4f2a5198dd993/viewer/README.md).
- [Licenza MIT](https://github.com/tt-a1i/archify/blob/9e35d2b0b39b155553ba9fcfe0b4f2a5198dd993/archify/LICENSE).

Risultati rilevanti:

1. Il template ha **774.866 byte**, coerenti con la stima di circa 775 KB; SHA-256 `505f1c6baa9c2454475c048aa75df8abd867e680e7b3b794b9218a95a56fc370`.
2. È una shell per HTML/SVG già generato, non un generico motore JSON→grafo aggiornabile. Contiene placeholder da materializzare.
3. Il viewer legge identità e relazioni dal DOM SVG. Alcune capacità interrogano il DOM dinamicamente, altre no: **Node Finder indicizza una volta**, Camera/Reader/Radar catturano geometria iniziale, alcuni hit target vengono creati una volta.
4. I moduli hanno in prevalenza durata pari alla pagina e non espongono `mount/unmount/destroy`. Non basta sostituire `innerHTML` o aggiungere `postMessage`.
5. Il template contiene font WOFF2 embedded e relativa licenza **SIL OFL 1.1**. Preservare questi avvisi oltre alle attribuzioni MIT di Archify/Cocoon AI.

**Primo gate:** confermare questo upstream/versione, oppure sostituirlo con l'artefatto specifico del proprietario. Non importare un branch `main` mobile senza revisione e checksum.

## 2. Architettura proposta

```text
Pi / publisher Trajectory esistente
    │ snapshot e RPC già disponibili
    ▼
server Trajectory esistente ── /ws ──► main app nel browser
                                         │
                                         ├─ Timeline/Gantt [default]
                                         │  transcript / inspector / azioni
                                         │
                                         └─ clic esplicito “Semantic Map”
                                              │ crea iframe + bridge
                                              │ payload JSON bounded
                                              ▼
                                      semantic-map.html
                                      semantic-map.js
                                      semantic-map.css
                                              │
                                      adapter puro, nel browser
                                              │ GraphModel
                                      renderer SVG incrementale
                                              │
                                      shell/interazioni Archify
```

### Responsabilità

- **Main app:** unico proprietario del WebSocket, dello stato accettato, della cache transcript e della selezione. Trasferisce soltanto una proiezione consentita del target corrente quando la mappa è attiva.
- **Adapter:** converte la proiezione Trajectory nel modello semantico. Risiede nel bundle lazy dell'iframe, non nel processo Node e non nel percorso iniziale del Gantt.
- **Renderer:** traduce `GraphModel` in SVG compatibile con i contratti DOM Archify. Gestisce geometria e aggiornamenti, senza importare il compilatore Node Archify.
- **Shell Archify:** zoom/pan, ricerca, focus e relazioni validate dallo spike, con un profilo essenziale. Le sue cache dipendenti dal grafo devono poter essere aggiornate esplicitamente; nessun obbligo di adattare tutte le capacità upstream.
- **Server:** serve tre route statiche esplicite, solo quando richieste. Nessun observer, adapter, layout, polling o processo dedicato alla mappa.

Il bundle `semantic-map.js` contiene viewer, adapter, renderer e bridge lato iframe. Tre sono gli **asset frontend aggiunti e distribuiti**; script di manutenzione, sorgenti propri, test e avvisi legali non sono ulteriori asset caricati dal browser.

### Nessuna nuova dipendenza

- Non installare Archify, React, D3, Cytoscape, vis, ELK o altri pacchetti.
- Nessuna nuova voce `dependencies`, `devDependencies` o `peerDependencies`; lockfile invariato salvo ragioni separate e approvate.
- Non copiare `node_modules`, CLI, validator, generatori, esempi o compilatori dell'intero upstream.
- Per assemblaggio/minificazione usare strumenti già presenti, oppure Node built-in. Normale build offline dai file versionati; download upstream soltanto tramite aggiornamento maintainer esplicito.
- Conservare provenienza, licenze e una patch locale riproducibile. “Nessuna dipendenza npm” non significa assenza di codice terzo da mantenere.

## 3. Lazy loading e ciclo di vita

**Requisito verificabile: nessun lavoro specifico della mappa quando non è aperta.** Non promettere “zero byte/zero istruzioni” in assoluto: esistono tab, piccolo loader, metadati di versione e spazio nel package.

| Stato | Comportamento |
| --- | --- |
| Mai aperta | Nessun iframe, richiesta ai tre asset, adapter, grafo, listener `message` dedicato, timer, worker o serializzazione della mappa. |
| Primo clic | Crea iframe e listener temporanei; handshake; legge lo stato corrente; invia snapshot iniziale. Non riproduce un backlog di eventi. |
| Aperta | Aggiornamenti solo per il target selezionato; aggregazione dei cambiamenti e coda limitata. Gli aggiornamenti di altri target non causano layout. |
| Ritorno a Timeline | Disconnette bridge/subscription, annulla timer, invalida generazione e **rimuove l'iframe**. Non lo nasconde soltanto con CSS. |
| Riapertura | Nuovo iframe, nuova generazione, snapshot corrente. Si possono conservare soltanto preferenze UI piccole e bounded, non una copia dello stato live. |
| Pagina browser nascosta | Sospende invii/layout/animazioni e invalida il lavoro pendente; al ritorno risincronizza dallo stato corrente. La sospensione va verificata anche per timer non governati da Archify. |
| Errore/timeout | Mostra errore nella scheda con “Riprova” e “Torna a Timeline”; nessuna conseguenza sul socket o sul run. |

- Non aggiungere `preload`, `prefetch`, import eager o iframe con `src` nascosto. `loading="lazy"` da solo non basta.
- Non riaprire automaticamente la mappa dopo un reload tramite localStorage o URL. Un eventuale deep link mostra un pulsante di apertura, senza avviare il viewer.
- All'uscita azzerare riferimenti a frame, porte, code e callback. La distruzione del browsing context evita di dover provare il cleanup di ogni IIFE upstream fuori uso.
- Le risposte asincrone di una vecchia apertura non possono ricreare il frame o alterare la selezione dopo la chiusura.
- La cache HTTP può aiutare le riaperture, ma non è una scusa per tenere attivo il viewer.

**Confine della garanzia:** nessun nuovo lavoro runtime ricorrente nell'estensione; assenza di caricamento/esecuzione del viewer a scheda chiusa. Quando aperta, browser e server pagano realmente trasferimento, parsing e rendering. Un iframe non garantisce un processo browser separato né elimina la contesa CPU con il Gantt.

## 4. UI e rimozione completa di Mermaid

Aggiungere una tabbar di vista: **`Timeline | Semantic Map`**, ortogonale al target run/agent/subagent già selezionato. Non sovraccaricare `setView` con una modalità che finirebbe nel ramo agent esistente.

- `Timeline` conserva il Gantt nativo come oggi, transcript, inspector, controlli e selezione temporale.
- Rimuovere entrambi i pannelli `TOOL TOPOLOGY` e `TOOL INVOCATION TOPOLOGY` Mermaid, evitando spazio vuoto e splitter residui.
- `Semantic Map` usa lo stesso target; supporta vista di run, focus agente e subagent standalone. Home senza target mostra un invito alla selezione senza caricare il viewer.
- Selezionare un nodo mostra dettagli sintetici; “Apri nel transcript” risolve un riferimento stabile nella main app. Non spedire indici di array come identità permanente.
- V1 read-only: stop/steer/retry/checkpoint/share rimangono esclusivamente nei controlli Trajectory esistenti.
- Tab con `role=tablist/tab/tabpanel`, focus da tastiera, loading/error annunciati, tema coerente e rispetto di `prefers-reduced-motion`.
- Non confondere “Live” come modalità di animazione Archify con la freschezza dei dati. Mostrare separatamente connessione, aggiornamento e completezza.

### Checklist di eliminazione

- Eliminare `packages/core/trajectory/src/assets/mermaid.min.js`.
- Eliminare script tag, inizializzazione, generazione DSL, rendering, zoom e binding esclusivi di Mermaid in `assets/index.html`.
- Eliminare CSS, stato `topologyRender`, preferenze e controlli esclusivi dei vecchi pannelli. Ignorare in modo tollerante le vecchie chiavi salvate, senza cancellare preferenze Gantt.
- Eliminare route `/mermaid.min.js` in `server.ts`; deve tornare 404 dopo la migrazione.
- Eliminare lettura/hash Mermaid in `trajectoryFingerprint` e lettura/inlining in `export.ts`.
- Sostituire regole di package, checksum e test che richiedono Mermaid con contratti dei tre asset Archify.
- Aggiornare `eslint.config.js`, `README.md`, `docs/llm.md`, `docs/subagents.html` e aggiungere una nuova voce al changelog.
- Conservare la storia del changelog e questo piano: “assenza di Mermaid” significa nessun asset o percorso operativo, non riscrittura dei commit/documenti storici.

**Non riutilizzare ciecamente il modello Mermaid.** Alcune sue funzioni deducono il completamento dei tool dallo stato dell'agente e costruiscono branch/join sintetici per turno: non sono evidenza sufficiente per la nuova mappa semantica.

## 5. Modello semantico e fedeltà ai dati

Contratto interno proposto:

```ts
interface GraphModel {
  schemaVersion: 1;
  scope: { publisherId: string; targetKind: 'run' | 'subagent'; targetId: string; agentId?: string };
  nodes: SemanticNode[];
  edges: SemanticEdge[];
  completeness: { partial: boolean; reasons: string[]; omittedNodes?: number; omittedEdges?: number };
}
// node.kind: workflow | task | agent | tool-call | result | control
// edge.kind: contains | invokes | produces | dependency | fork | merge | retry
// Ogni elemento conserva sourceRef ed evidence: recorded | structural | unavailable.
// Lo stato mantiene sia rawStatus sia il valore normalizzato di presentazione.
```

### Provenienza degli elementi

| Elemento | Dati utilizzabili | Regola |
| --- | --- | --- |
| Workflow | `record.run.id`, `workflowName`, `state` | Un nodo per run. |
| Task/scope | `structuralPath`, `phaseHistory`, identità registrate | Gruppi strutturali, non task inventati dai prompt. La fase non prova una dipendenza. |
| Agent | `agents`, `parentId`, `attempts`, `attemptDetails` | Distinguere identità agente e tentativo; validare parent mancanti/ciclici. |
| Subagent | record standalone e `progress.toolCalls` | Stesse regole, con namespace distinto dai run. |
| Tool call | `agent.toolCalls`, progress, timing e transcript già disponibili | Join per `toolCallId` e tentativo. Rispettare lo stato esplicito della singola chiamata. |
| Result | risultato tool associato, `resultPath` dell'agente, risultato/failure standalone | Nodo di risultato o riferimento ad artefatto; non leggere file o corpi completi per disegnarlo. Un path non certifica la disponibilità del contenuto. |
| Retry agente | numero/record di tentativo | Relazione tra tentativi noti; segnalare storia incompleta se restano solo gli ultimi tentativi. |
| Retry run | `run.retry.sourceRunId` e relativa provenance | `parentRunId` da solo non significa retry: può indicare riuso di worktree. |
| Dependency/fork/merge | metadati che documentano effettivamente la relazione | Non inferire causalità da vicinanza temporale, nomi, ordine degli agenti o geometria. |

L'attuale trasporto non espone un DAG completo con tutti i fork, merge e dipendenze di esecuzione. Il contratto li supporta, ma il viewer mostra **solo quelli comprovati**. Scope `parallel`/`pipeline` possono essere rappresentati come struttura identificata, senza affermare che un join sia avvenuto. Qualunque relazione derivata deve avere regola documentata e stile distinguibile dalla causalità registrata.

Se l'obiettivo richiede una ricostruzione completa anche dopo riapertura/reconnect, servirà un successivo intervento sui metadati persistiti/trasmessi da Trajectory: è fuori dalla prima integrazione frontend e richiede rivalutare esplicitamente il vincolo di costo nullo quando la mappa non è usata. Nessuna analisi LLM, esecuzione dello script workflow o scraping del DOM Gantt per inventare relazioni mancanti.

### Identità e stati

- ID deterministici derivati da tuple `publisher / target / agent / attempt / toolCallId`, codificate senza ambiguità e sicure per selettori SVG. Per gli archi includere kind e ID della relazione, se disponibile.
- Mai derivare l'identità da etichetta, posizione o indice del nodo. Se la sorgente non ha un ID stabile, marcare l'elemento come limitato allo snapshot e non navigabile persistentemente.
- Stati minimi richiesti: `running`, `success`, `failure`; conservare inoltre `queued`, `waiting`, `paused`, `retrying`, `cancelled`, `interrupted`, `unknown` e lo stato originale.
- `completed → success`, `failed → failure`; `stopped/cancelled` non diventano success; `budget_exhausted` resta una condizione distinta e visibile.
- Tool senza risultato e senza stato conclusivo esplicito resta unknown/running secondo l'evidenza, anche se l'agente è concluso.
- Uno snapshot `truncated` o un transcript parziale produce un badge di incompletezza. Non conservare silenziosamente elementi omessi presentandoli come live.
- Publisher scomparso, generazione cambiata o socket chiuso: invalidare lo scope oppure mostrare esplicitamente “non aggiornato”, seguendo la selezione della main app.

### Transcript e dati sensibili

La vista generale usa metadata, timing e tool call già trasmessi. Non richiede tutti i transcript di tutti gli agenti. Il dettaglio esplicito riusa `requestTranscript` e la cache esistenti; invalida le risposte obsolete per revisione/target/generazione.

Il payload verso il viewer esclude system prompt, script, environment, credenziali, argomenti completi e output integrali. Include etichette limitate, stato, conteggi e riferimenti interni opachi. Un eventuale estratto testuale è opt-in e limitato; il transcript completo rimane nel suo inspector.

## 6. Bridge live e sicurezza

Envelope versionato proposto, formato JSON-compatible:

```json
{
  "channel": "trajectory:semantic-map",
  "version": 1,
  "viewerInstanceId": "opaque-per-open-id",
  "scopeEpoch": 3,
  "sequence": 12,
  "type": "source-snapshot",
  "payload": { "scope": {}, "source": {}, "completeness": {} }
}
```

`viewerInstanceId`, epoch e sequence sono identificatori del bridge, non nuove revisioni autorevoli di Trajectory. I token di revisione transcript esistenti sono opachi: verificarne uguaglianza, non monotonicità numerica.

### Flusso

1. Clic → creazione iframe e nuovo ID di istanza.
2. `ready` / `init` con versione e nonce, quindi trasferimento di un `MessagePort` alla finestra verificata.
3. Snapshot completo bounded del target corrente; adapter nell'iframe; `applied` con sequence.
4. Dopo ogni stato accettato o dettaglio transcript pertinente: al massimo uno snapshot in elaborazione e uno più recente in attesa. Ultimo stato prevalente, nessun backlog illimitato.
5. Cambio target o generazione publisher: incrementare epoch e inviare reset/snapshot; scartare risposte vecchie.
6. Disconnessione, timeout o versione incompatibile: stato visibile e retry esplicito. Nessun fallback a Mermaid.

V1 usa snapshot completi dello **scope selezionato**, deduplicati e bounded: è più semplice e corretto del replay di eventi incompleti. Il rendering SVG è incrementale. Patch `upsert/remove` sul trasporto sono un'ottimizzazione successiva, solo se misurata utile; richiedono `baseSequence`, ack e snapshot di recupero.

### Confine di sicurezza

- Preferire iframe `sandbox="allow-scripts"`, senza `allow-same-origin`, senza navigazione del parent, popup, form o download automatici; `referrerpolicy="no-referrer"`.
- Con sandbox opaque, l'origin del child nei messaggi è `null`: **non fidarsi di `origin === 'null'` da solo**. Validare `event.source === iframe.contentWindow`, istanza, nonce, versione e fase dell'handshake.
- Il bootstrap verso un child opaque richiede `targetOrigin: '*'`: limitarlo al trasferimento della porta verso quella specifica `contentWindow`, senza dati del run. Dopo l'handshake trasferire i payload soltanto sulla porta privata e chiuderla al dispose. Il child verifica il parent atteso e non accetta reinizializzazioni arbitrarie.
- Verificare nel browser reale caricamento dei tre asset, CSP e funzionalità Archify sotto sandbox. Non aggiungere `allow-same-origin` per far passare i test presentandolo come isolamento forte: cambierebbe il modello di sicurezza e richiederebbe una decisione esplicita.
- CSP dedicata alle route Semantic Map: bloccare connessioni (`connect-src 'none'`), frame, oggetti, base URL e form; consentire solo script/style locali necessari e font/immagini embedded. Niente `eval`, CDN, analytics o fetch dal viewer. Tarare le direttive sul sandbox nello spike.
- Validare shape, tipi, enumerazioni, lunghezze, conteggi, unicità ID e riferimenti di ogni messaggio in entrambe le direzioni. Limiti applicati prima dei lavori costosi.
- Testo via `textContent`, elementi SVG via namespace e attributi allowlisted. Mai accettare HTML/SVG grezzo, `on*`, `javascript:` o URL arbitrari dal payload.
- Il viewer può emettere `select`/`open-detail`, non comandi di controllo workflow. La main app risolve l'ID contro il proprio target attuale; non esegue istruzioni dal messaggio.

## 7. Renderer e adattamento Archify: gate principale

Realizzare prima un prototipo su fixture, non una promessa di import plug-and-play.

1. Separare in modo deterministico HTML, CSS e JS dal template fissato; conservare ordine di inizializzazione, font e attribuzioni. Preservare gli assunti di esportazione che dipendono da `#archify-fonts` oppure dichiarare la capacità non supportata.
2. Aggiungere renderer SVG minimale senza librerie: layout per livelli/scope, spazio stabile per agenti e tentativi, instradamento semplice degli archi, nodi raggruppati/collassabili.
3. Stato/contatori aggiornano attributi e testo senza rifare il layout. Nuove entità possono richiedere layout; mantenere posizioni esistenti quando possibile. Cicli e retry non devono mandare in loop il layout.
4. Introdurre un lifecycle locale esplicito, ad esempio `setGraph`, `updateStatus`, `resetScope`, `dispose`. Sono **API dell'integrazione da costruire**, non API Archify già disponibili.
5. Riindicizzare Finder e hit target, aggiornare geometria Camera/Reader/Radar e invalidare focus/route non più esistenti. Non reinvocare IIFE accumulando listener e non ricreare l'intero iframe a ogni snapshot.
6. Conservare pan/zoom/focus sugli aggiornamenti ordinari; reset solo su cambio scope o comando utente. Animazioni limitate e disattivabili.

**Spike superato solo se:** inserimento/rimozione di nodi live, cambi di stato, ricerca dei nuovi nodi, selezione e resize funzionano; repeated open/close non lascia contesti attivi; nessuna richiesta esterna; test su rete bloccata e sandbox.

Se il viewer richiede un fork invasivo o un renderer molto più grande del previsto, fermarsi e presentare il nuovo costo. Non introdurre librerie, non ridurre il risultato a HTML statico e non mantenere Mermaid di nascosto per aggirare il requisito.

## 8. Limiti e performance

Budget iniziali da validare sullo stesso browser/hardware, non benchmark già ottenuti:

| Misura | Obiettivo iniziale |
| --- | --- |
| Scheda mai aperta | 0 richieste asset Semantic Map, 0 invocazioni adapter, 0 payload mappa, 0 iframe/worker/timer dedicati |
| Scheda chiusa dopo uso | Bridge/porte/frame rimossi, nessuna callback futura della vecchia istanza che compie lavoro |
| Volume normale | Fino a 500 nodi / 1.500 archi visibili per scope |
| Payload bridge | Massimo iniziale 512 KiB; ridurre lo scope prima dell'invio, non clonare payload multi-MB per poi troncarli |
| Frequenza | Al massimo 4 invii/s, coalesced; normalmente segue il publisher da circa 1 snapshot/s |
| Aggiornamento stato ordinario | Target p95 ≤ 100 ms dalla ricezione browser, escludendo latenza publisher/rete |
| Primo caricamento locale | Target p95 ≤ 1 s su macchina/browser di riferimento, da confermare nello spike |
| Stabilità | 50 cicli apri/chiudi e 10 minuti di aggiornamenti: niente crescita monotona di frame, listener, code o heap dopo GC |

Per scope più grandi mostrare gruppi collassati, filtro per agente/tentativo e conteggi degli elementi omessi; non renderizzare migliaia di tool/result di default. Aggiornamenti di solo stato non devono generare layout globale. Un worker non è previsto nel primo rilascio; valutarlo soltanto su evidenza di blocchi e con il vincolo dei tre asset ancora rispettato.

## 9. Peso, packaging, cache e fingerprint

### Numeri misurati e stime

| Voce | Dimensione | Qualifica |
| --- | --- | --- |
| Template upstream Archify | 774.866 byte | Misurata sul raw fissato sopra |
| Gzip dello stesso template | 190.436 byte | Misura locale con `node:zlib`, non traffico HTTP effettivo |
| Brotli dello stesso template | 159.884 byte | Misura locale con `node:zlib`, non build finale |
| Mermaid attuale | 3.572.899 byte | Dimensione del blob versionato/contratto package; checkout Windows può differire per CRLF |
| Bridge + adapter + renderer + adattamenti | 10–50 KB come ipotesi iniziale | **Non validata**, soprattutto per lifecycle e layout |
| Tre asset finali | Circa 0,8–0,85 MB se l'ipotesi regge | Budget iniziale, gate di revisione a 1 MB |

Rispetto al vecchio fork con Mermaid, la sostituzione avrebbe potuto ridurre di circa **2,7 MB** la componente grafica non compressa. **Questo risparmio NON si applica alla nuova base ufficiale v5.17.0, che non contiene Mermaid:** Archify è un incremento netto da misurare e contenere. Verificare il delta completo rispetto a `b866367` con la build finale e il tarball reale; il package contiene anche altro codice.

Il server attuale serve gli asset con `Content-Length` e `Cache-Control: no-store`, **senza compressione HTTP**. Pertanto 200–300 KB non sono oggi una garanzia di trasferimento: in V1, se il server resta invariato su questo punto, prevedere circa la dimensione raw dei tre file al primo caricamento. La compressione del tarball npm è un'altra misura.

### Packaging e aggiornamenti

- Copiare i tre asset in `dist/trajectory/src/assets/` attraverso il build esistente.
- Escludere dal package la seconda copia sotto `trajectory/src/assets/semantic-map.*`, analogamente all'esclusione oggi dedicata a Mermaid; verificare il percorso effettivamente servito nelle installazioni source e npm.
- Aggiungere avvisi legali e un manifest di provenienza/checksum **di manutenzione**, non caricato come quarto asset UI.
- Normale build riproducibile/offline; verificare byte/checksum con line ending definiti, evitando errori CRLF nei test package.
- Non includere le copie vendor dentro i bundle Node, sourcemap con contenuto completo o fixture HTML duplicate nel tarball.
- Fingerprint: sostituire il digest Mermaid con un piccolo ID build generato dai tre asset. Leggere/importare solo tale costante o manifest minimo, non gli 800 KB. Aggiornare l'ID insieme agli asset e testarne la freschezza; includerlo esplicitamente nel confronto del lock.
- Usare URL versionati e policy cache documentata per i tre asset; index/stato rimangono freschi. Testare aggiornamento package con server già avviato e mismatch di versione bridge/viewer.
- Compressione HTTP eventuale con Node built-in e solo su richiesta: fase opzionale misurata, nessun nuovo servizio e nessun lavoro eager. Non aggiungere `.gz/.br` come ulteriori artefatti distribuiti senza rivedere il vincolo dei tre asset.

## 10. Export e compatibilità offline

**Decisione V1: Semantic Map live soltanto; export/share esistenti continuano a funzionare senza Mermaid.**

- Rimuovere lettura e inlining Mermaid da `exportTrajectoryRunHtml`.
- In modalità `window.__PIEWF_STATIC__` la scheda Semantic Map è disabilitata o spiega chiaramente che questa versione richiede Trajectory live. Nessun iframe o fetch semantic-map viene avviato.
- Preservare Gantt, transcript, inspector e navigazione offline, compreso il report aperto tramite `docs/run.html`.
- La topologia Mermaid non esiste più nemmeno nell'export: documentare questa differenza, non sostituirla con una schermata vuota.
- Export Archify/clipboard/WebM non sono criteri obbligatori V1: verificarli singolarmente nel sandbox e nascondere quelli non supportati; niente pulsanti che falliscono silenziosamente.

Successiva opzione esplicita: “includi Semantic Map nell'export”, con i tre asset incorporati come dati inerti e iframe creato soltanto al clic, snapshot statico e nessun WebSocket. Aumenta la dimensione del report anche se non aperta; non confonderla con il costo zero runtime a scheda chiusa.

## 11. Sequenza di implementazione

### F0 — Provenienza, spike e baseline

- [ ] Confermare upstream/commit, licenze, capacità minime e modello sandbox; documentare la superficie di patch e scegliere il profilo con minore onere di manutenzione.
- [ ] Registrare baseline package, richieste e tempi Gantt; verificare misure raw/gzip/brotli senza promettere HTTP compresso.
- [ ] Prototipo live su fixture: insert/remove/status, reindex, layout stabile, CSP e repeated open/close.
- [ ] Decidere go/no-go su adattamento viewer e budget: niente rimozione isolata di Mermaid lasciando una migrazione interrotta.

### F1 — Tre asset e modello puro

- [ ] Import controllato e riproducibile dei soli asset necessari, con provenance/licenze.
- [ ] Adapter, GraphModel, identity, stato e completezza; fixture per run/agent/subagent/tool/result/retry e scope strutturali.
- [ ] Renderer SVG e lifecycle Archify con i test individuati in F0.

### F2 — Tab e bridge realmente lazy

- [ ] Tab ortogonale a target/view esistenti, default Timeline e gate di clic.
- [ ] Proiezione allowlisted solo mentre attiva; handshake/porta, snapshot iniziale, coalescing, reset e cleanup.
- [ ] Navigazione a dettagli attraverso riferimenti risolti dal parent; temi e accessibilità.

### F3 — Sostituzione atomica di Mermaid

- [ ] Collegare le tre route, MIME, CSP, cache e ID build/fingerprint.
- [ ] Rimuovere asset, pannelli, codice e route Mermaid, senza modificare il renderer Gantt.
- [ ] Aggiornare package allowlist, lint, test lock/server/UI e checksum.
- [ ] Aggiornare export/share per la decisione live-only, senza richieste pendenti a Mermaid o Archify.

### F4 — Verifica, misure e documentazione

- [ ] Eseguire matrice dei test sotto riportata e suite esistenti.
- [ ] Verificare tarball: una copia di ogni asset, nessun Mermaid operativo, nessuna nuova dipendenza.
- [ ] Pubblicare misure e limiti reali; aggiornare README/docs e changelog.
- [ ] Revisione finale: nessuna pretesa di completezza causale o “zero impatto” non verificata.

### File interessati

Percorsi relativi alla root; i nuovi percorsi sono proposti, non già creati:

| Percorso | Intervento previsto |
| --- | --- |
| `packages/core/trajectory/src/assets/index.html` | Tab, loader minimo e hook gated; eliminazione UI/codice/CSS Mermaid |
| `packages/core/trajectory/src/assets/semantic-map.{html,js,css}` | Tre nuovi artefatti browser |
| `packages/core/trajectory/src/semantic-map/` | Sorgenti propri adapter/renderer/bridge, non importati dagli entrypoint Node |
| `packages/core/trajectory/vendor/archify/` | Provenienza, avvisi e patch riproducibile; nessuna copia dell'intera repo upstream |
| `scripts/update-semantic-map.mjs` | Aggiornamento maintainer esplicito/verifica; nessun download nella build normale |
| `packages/core/trajectory/src/server.ts` | Route esplicite e header; rimozione route Mermaid |
| `packages/core/trajectory/src/index.ts` | Fingerprint piccolo, rimozione hash/lettura Mermaid |
| `packages/core/trajectory/src/export.ts` | Rimozione inlining Mermaid, export live-only coerente |
| `packages/core/package.json`, `eslint.config.js` | Build/package, nessuna nuova dipendenza; evitare di escludere dal lint il codice proprio |
| `scripts/verify-packed-packages.mjs`, `packages/core/test/workspace-layout.test.mjs` | Asset unici, checksum/versione, assenza runtime Mermaid |
| `packages/core/trajectory/test/trajectory*.test.ts` | Rimozione sole aspettative Mermaid; conservazione e ampliamento regressioni esistenti |
| `packages/core/trajectory/test/semantic-map*.test.ts` | Adapter/bridge/lifecycle/limiti e harness browser senza nuove dipendenze npm |
| `README.md`, `docs/llm.md`, `docs/subagents.html`, `CHANGELOG.md` | Descrizione corretta della sostituzione e dei limiti |

L'harness browser deve utilizzare un browser locale/CI e primitive già disponibili o CDP via Node. I mock VM non dimostrano isolamento, assenza di fetch, cleanup iframe, layout o CSP reali. Se il browser non è disponibile, il gate resta non verificato: non installare un framework di test nuovo senza autorizzazione.

## 12. Matrice di accettazione

### Nessuna regressione

- Gantt principale, collasso/resize, selezione temporale, cursor sync, transcript, inspector e scroll invariati.
- Navigazione run/agent/subagent e back/forward consistente anche entrando/uscendo dalla mappa.
- Azioni esistenti, server lock, reconnect, publisher replacement e protezioni su payload oversized ancora coperti.
- Export file/offline e share visualizzano il contenuto esistente, senza errori per asset rimossi.

### Dati e bridge

- Stesso snapshot → stesso grafo; duplicate tool ID/attempt, label identiche, parent invalidi e cicli non corrompono il modello.
- Retry interno distinto da nuovo run di retry, riuso worktree e record standalone senza provenance.
- `truncated`, timing-only, result mancante, transcript stale/oversized e stati non terminali esposti correttamente.
- Snapshot durante handshake, risposte dopo chiusura, cambio scope, generazioni publisher e version mismatch non contaminano il target corrente.
- Rendering lento mantiene al massimo un lavoro attivo e uno snapshot pending, recuperando l'ultimo stato.

### Browser, sicurezza e lifecycle

- Cold load e attività Gantt prolungata: zero richieste `semantic-map.*`, zero adapter e nessun frame.
- Primo clic: solo asset locali attesi, nessun socket della mappa e nessuna rete esterna.
- Nuovi nodi cercabili/focalizzabili; nodi eliminati non restano in Finder, Radar o route.
- 50 cicli apri/chiudi; cambio scheda prima del ready; close durante render; resize e hidden/visible senza leak o callback obsolete.
- Rifiuto messaggi da altra finestra/iframe, nonce/istanza/versione errati, ID sconosciuti e payload oltre limite.
- Test XSS su label/output, URL e attributi SVG; nessuna capacità di pilotare azioni workflow dal frame.
- Temi, tastiera, focus, reduced motion e layout a larghezze ridotte verificati nel browser.

### Build e distribuzione

Comandi esistenti da eseguire durante l'implementazione, dopo l'installazione delle sole dipendenze già dichiarate:

```sh
npm ci
npm run check
npm run test:packages
npm run pack:core
```

Aggiungere i nuovi test ai comandi già usati dalla CI, senza suite semantic-map non eseguite. Registrare `.tgz`, unpacked size, somma dei tre asset, dimensioni compresse e trasferimento HTTP reale separatamente. Confrontare la regressione “mappa chiusa” con la baseline raccolta in F0.

## Esito atteso

Una sola visualizzazione grafica opzionale: **Archify Semantic Map**, al fianco del **Gantt nativo predefinito**. Nessun Mermaid nel percorso operativo o nel package grafico finale, nessuna nuova dipendenza npm, nessun secondo flusso live. Costi della mappa attivati dalla scelta dell'utente e dati semantici fedeli all'evidenza effettivamente disponibile in Trajectory.

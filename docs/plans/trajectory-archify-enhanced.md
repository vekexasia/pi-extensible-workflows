# Trajectory Enhanced — mappa operativa per workflow lunghi

## 0. Mandato, stato e precedenza

**Stato: proposta di piano; implementazione enhanced differita fino al completamento e alla prova visibile della versione attuale. Nessun gate è dichiarato superato da questo documento.**

### Priorità concordata: prima una baseline utilizzabile e visibile

Il proprietario ha scelto di **completare prima la versione attuale**, vedere i risultati di almeno un test riproducibile in Trajectory e soltanto dopo procedere con l'enhanced. Non anticipare H0–H7 durante la chiusura corrente e non usare l'enhanced per rinviare i difetti che bloccano il perimetro già promesso.

Sequenza di consegna:

1. Completare i fix e i gate W0–W8 del [piano Windows/candidato attuale](trajectory-archify-windows-deploy.md), mantenendo distinta la futura release/deploy W9.
2. Consegnare la **prova visibile V0-D**, descritta nella sezione W5-D dello stesso piano: scenario, test automatico, risultato apribile localmente e istruzioni, immagini del browser e limiti osservati. Un log «test passato» non basta.
3. Registrare nel [ledger](trajectory-archify-implementation.md) il candidato esatto, gli esiti effettivi e il riscontro del proprietario sulla prova. La demo può essere mostrata prima della matrice completa solo come preview con gate ancora aperti; non significa versione completata.
4. Dopo la chiusura della baseline e la visione dei risultati, confermare il passaggio a H0. Riutilizzare lo stesso scenario come confronto prima/dopo; aggiungere poi i carichi lunghi S/M/L.

La baseline mantiene i limiti attuali dichiarati (16/8/16, tail transcript, layout semplice ed export live-only) finché non affrontati dall'enhanced. Non aumentare il perimetro per rendere la demo più impressionante e non nascondere le omissioni. Bug di sicurezza, correttezza o delle funzioni già richieste restano da risolvere nel percorso corrente.

**Non è richiesto pubblicare su npm, effettuare un deploy pubblico o installare nel profilo Pi personale per far vedere il risultato.** La prova usa un ambiente isolato e il browser viene aperto solo volontariamente; nessun editor reale o associazione di file `.sh`.

**Correzione di perimetro: storage-first.** La sessione e gli artefatti del run conservano già gran parte dei dati necessari. Non confondere «assente dallo snapshot inviato al viewer» con «mai registrato». Il nucleo enhanced deve recuperare e correlare prima le fonti esistenti in sola lettura. Nuova telemetria/persistenza è un'eventuale estensione separata H3, subordinata a lacune dimostrate: non blocca la consegna del nucleo operativo.

Risultato richiesto: trasformare Semantic Map da griglia dimostrativa in uno strumento per capire **cosa sta lavorando, cosa attende, cosa ha fallito, quanto costa e dove intervenire** in un workflow lungo, senza leggere tutti i transcript.

Baseline di codice esaminata: `feat/trajectory-archify-v5.17.0`, commit `90474fb7fb6b6b8f26f765792cafd4bdf7f1ca20`. Confronto funzionale: Mermaid del vecchio fork, commit `f94fd0205c900768d7bace20e2d31bffa6a99849`. La base ufficiale v5.17.0 non conteneva Mermaid: non confondere un recupero di funzionalità del fork con una regressione upstream.

Al momento della redazione esistono modifiche concorrenti al ledger, ai manifest, agli script/test di portabilità e un piano Windows non committato. L'aggiornamento della priorità riguarda solo questo piano, il piano Windows e il ledger; **non modifica i sorgenti o le verifiche runtime in corso**. Prima dell'esecuzione rilevare nuovamente HEAD e diff; un solo integratore per i sorgenti condivisi.

Fonti locali:

- [Piano originale](trajectory-archify-semantic-map.md): contratti lazy, privacy, sandbox e budget iniziali.
- [Base ufficiale](trajectory-archify-upstream-baseline.md) e [ledger storico](trajectory-archify-implementation.md): evidenze, non approvazioni implicite.
- [Piano Windows e distribuzione](trajectory-archify-windows-deploy.md): owner dei fix di toolchain/processi, framing, URL versionati, packaging e deploy.
- [Guida contributor](../developers.html#evaluation) e [AGENTS.md](../../AGENTS.md): verifica e confini.

### Vincoli mantenuti e cambiamenti proposti

| Tema | Decisione del piano enhanced |
| --- | --- |
| Gantt | Resta predefinito; mantiene tempi, selezione temporale e controlli esistenti. |
| Viewer | Archify resta l'unico viewer semantico. Nessun fallback Mermaid nascosto. |
| Fonte autorevole | RunStore, scheduler e sessioni/transcript esistenti; nessun secondo motore di workflow. |
| Sicurezza | Iframe opaque, porta privata, CSP, whitelist, navigazione risolta dal parent, nessuna azione mutante dal child. |
| Portabilità | Windows nativo e Linux obbligatori; integrare il piano Windows senza duplicarne i fix. URL versionati già scelti lì. |
| Dipendenze | Archify è un artefatto frontend standalone fissato e riproducibile, non una nuova libreria npm. Nessun nuovo pacchetto grafico, import del compilatore/generatore Archify o bundle del viewer nel Node runtime. |
| Limiti 16/8/16 | Da eliminare come limiti del dominio. I budget limitano pagine, memoria e scena visibile, non l'esistenza degli elementi esplorabili. |
| Perimetro frontend-only | Estendere loader/RPC di ispezione per leggere i dati **già persistiti**, senza nuovi record runtime nel nucleo. Cambiare la lettura non richiede cambiare il formato di registrazione. |
| Costo a mappa chiusa | Nessun layout, query, scansione o stream dedicato alla mappa; nessuna nuova scrittura osservativa nel nucleo. Eventuali costi di H3 saranno oggetto di proposta e misura separate. |
| Export | Ripristinare la topologia offline è una fase esplicita successiva al nucleo operativo; non attivare automaticamente export/download Archify. |
| Operazioni esterne | Il piano non autorizza commit, push, merge, installazione personale, nuove dipendenze, release o deploy. |

### Architettura vincolante: viewer live standalone e attivazione esplicita

Chiarimento terminologico: qui «nuova telemetria» indicava nuovi hook/eventi/log persistenti da produrre per ogni workflow, **non analytics o invio a servizi esterni**. Non è necessaria per la mappa dei dati conservati e non è inclusa nel perimetro. La registrazione che l'estensione effettua già oggi rimane invariata; H3 è soltanto un'eventuale proposta esterna al nucleo, mai un requisito nascosto.

```text
Dati/eventi Trajectory e sessioni già conservate
        │ trasporto/loader esistenti, eventuali pagine su richiesta
        ▼
Main app Trajectory — stato accettato, selezione e unico WebSocket
        │ SOLO dopo clic sulla scheda Semantic Map
        │ snapshot/pagine JSON allowlisted e aggiornamenti pertinenti
        │ bootstrap postMessage → MessagePort privata
        ▼
Viewer standalone nel browser
        adapter: dati/eventi → nodi, archi e copertura
        proiezione di vista: gruppi / focus / livello di dettaglio
        rendering incrementale + shell/interazioni Archify
```

- **Browser, non estensione Node:** adapter semantico, grafo, aggregazioni visuali, ricerca nella scena e layout risiedono nel bundle lazy del viewer. Il parent conserva l'autorità sulle fonti e valida le richieste; non aggiungere un secondo adapter completo nel bundle iniziale.
- **Loader non è renderer:** per leggere pagine non ancora nel browser, Node può effettuare letture, filtri e conteggi dei record autorizzati su richiesta. Non genera SVG, non esegue Archify e non mantiene un grafo live per ogni run. Se il parent possiede già i dati validi, riusarli invece di rileggerli.
- **Live, non statico:** dopo l'apertura il parent invia snapshot corrente e cambiamenti del perimetro attivo; non serve ricaricare HTML/iframe per ogni stato o espansione. Le entità aggregate aggiornano conteggi/stati; i dettagli aperti ricevono aggiornamenti pertinenti. Il tutto segue la cadenza effettiva di Trajectory, non una nuova sorgente di eventi.
- **Mai aperta:** nessuna richiesta dei tre asset, iframe, adapter, costruzione/index del grafo, serializzazione mappa, scansione delle sessioni, worker o timer dedicato. Nessun preload/prefetch o attivazione automatica da preferenze/deep link.
- **Chiusa dopo uso:** rimuovere iframe/porta, annullare richieste e lavori dedicati, liberare cache/index esclusivi e scartare risposte obsolete. Non mantenere il viewer nascosto. Non cancellare la cache transcript condivisa usata dalle altre viste.
- **Pagina nascosta:** sospendere gli invii e i lavori specifici; al ritorno applicare lo stato corrente coerente. In presenza di più tab, interrompere solo il lavoro appartenente al client che chiude, senza interferire con gli altri.
- **Tre asset frontend canonici**, generati offline dagli input fissati: `semantic-map.html`, `semantic-map.js`, `semantic-map.css`. Nessun CDN, servizio esterno, download di installazione o secondo WebSocket. L'HTML di shell è un artefatto statico di build; il grafo che ospita è aggiornato a runtime nel browser.

**Significato misurabile di «impatto zero»: zero lavoro runtime ricorrente specifico della mappa quando non è usata**, oltre al minimo codice di tab/attivazione e metadati di build. Non significa zero byte nel package: l'artefatto attuale misura circa 0,8 MB raw. A mappa aperta esistono costi di lettura/trasferimento e CPU/RAM browser da misurare. L'iframe non garantisce un processo separato o assenza di contesa con il Gantt. Il peso va tenuto contenuto, non nascosto dietro l'assenza di dipendenze npm.

## 1. Cosa deve poter fare l'operatore

Questi sono i criteri di prodotto dell'enhanced, non il numero di funzionalità Archify accese né capacità già consegnate dalla baseline.

Le tre superfici sono complementari:

- **Gantt:** quando avvengono le attività, durata e sovrapposizioni.
- **Archify:** struttura del lavoro, contesto delle criticità e collegamenti supportati dai dati.
- **Transcript/inspector:** evento esatto, input, risposta ed errore dettagliato.

Il valore aggiunto da misurare è il percorso **criticità → contesto → evidenza**, non una seconda rappresentazione degli stessi rettangoli. L'esempio guida è un run con 300 agenti e 20.000 chiamate: individuare i due errori della fase Verifica, espandere il gruppo, selezionare il tentativo e aprire la chiamata pertinente senza attraversare tutti i transcript.

| Domanda | Risposta richiesta dalla UI | Verifica operativa |
| --- | --- | --- |
| «A che punto siamo?» | Fase/scope corrente, conteggi distinti di completati, attivi, in coda e falliti; checkpoint e freschezza. | In un run con 300 agenti, individuare fase corrente e lavoro attivo senza scorrere 300 card. |
| «Perché non avanza?» | Attesa registrata, eventuale child/checkpoint preciso, coda o limite noto; altrimenti causa non disponibile. | Dal parent in attesa raggiungere il child pertinente o il checkpoint in massimo due attivazioni. |
| «Dov'è il problema?» | Elenco delle criticità sull'intero run disponibile, comprese quelle dentro gruppi chiusi o fuori pagina. | Un fallimento nell'agente 299 o nella tool call 10.001 è ricercabile e raggiungibile. |
| «Che cosa è successo a questo agente?» | Tentativi, turn osservati, tool call e risultato associato, durata e stato delle singole chiamate. | Navigare a un vecchio tentativo e al suo evento esatto, non all'ultimo risultato omonimo. |
| «Dove sto spendendo tempo e budget?» | Durata osservata, costo/token e ranking, distinguendo wall time, somme e dati mancanti. | Identificare le tre operazioni più costose/lente nel perimetro selezionato con copertura indicata. |
| «Cosa cambia con retry/reconnect?» | Run originario, tentativi, passi riusati, nuova generazione e dati stale espliciti. | Riaprire la UI senza perdere storia conservata e senza fondere identità diverse. |
| «Come intervengo?» | Collegamenti al transcript, al Gantt e ai controlli già autorizzati del parent. | Selezione coerente nelle viste; nessun click nel grafo esegue stop/retry/approve. |

Non promettere ETA, percentuale di completamento globale o critical path se il numero di passi futuri e le dipendenze non sono noti. «80/120 agenti osservati conclusi» non equivale a «workflow completato al 67%».

## 2. Gap verificati e conseguenze architetturali

| Evidenza attuale | Intervento necessario |
| --- | --- |
| `trajectory/src/semantic-map/index.ts`: primi 16 agenti, 8 relazioni, 16 tool call totali nel run; tool ricavati dalla cache transcript. | Proiezione per livello di dettaglio e query indipendenti dai transcript aperti prima dall'utente. |
| `semantic-map/renderer.ts`: otto colonne, card 105×48, connessioni geometriche semplici. | Layout per struttura/connessioni, testo misurato, gruppi espandibili e instradamento leggibile. |
| `semantic-map/adapter.ts`: supporta `relations`, ma `RunRecord` in `core/src/types.ts` non definisce un DAG generico `relations`. | L'assenza di un array pronto non prova assenza di relazioni recuperabili. Correlare prima identità, ownership, journal e call/result strutturati; documentare la fonte di ogni arco. |
| `types.ts`, `host-phases.ts`: phase history, structural path, parentId, shell attive, stato, accounting, retry e identità sono già disponibili. | Riutilizzare questi fatti e le regole condivise; non ricostruirli da label o pixel del Gantt. |
| `core/src/trajectory.ts`: lettura della coda entro 2 MiB e 400 entry non-timing; il loader seleziona l'ultimo tentativo. | Aumentare i limiti del renderer non recupera la storia. Servono query per tentativo e pagine del transcript sorgente. |
| `trajectory/src/index.ts` e `server.ts`: bounds e compattazione, ultimi otto tentativi, revisioni e timing del run focalizzato. | Trasmettere copertura e dettagli su richiesta; i nuovi dati non devono essere troncati di nuovo a monte senza segnalarlo. |
| `agent-execution.ts`: `get_subagent_result` riceve l'ID child; `agent` restituisce l'ID creato, e l'ownership conserva parentela/stato. | Cercare prima questi riferimenti nei transcript e negli artefatti; distinguere richiesta di risultato, attesa corrente e completamento. Un'assenza di risposta da sola non identifica sempre il child attualmente bloccante. |
| `execution.ts` e `host-runtime.ts`: `parallel`/`pipeline` hanno percorsi distinti worker e funzioni registrate. | Verificare i percorsi strutturali e i risultati già persistiti di entrambi. Nuovi eventi solo se un requisito operativo rimane realmente non ricostruibile. |
| `semantic-map.css` e template: colori delle card propri e preset non materializzato; embed nasconde anche Finder/navigation. | Profilo Archify esplicito, tema completo, comandi visibili e verificati. Non basta dichiarare che l'API esiste. |
| Mermaid `f94fd02`: overview per fasi/scope, dettaglio tool per turn, navigazione transcript, zoom e export offline. | Recuperare il valore operativo senza copiare inferenze errate, vecchio HTML o runtime Mermaid. |

**Ulteriore distinzione:** il limite di 16 agenti contemporaneamente ammessi dallo scheduler non limita il numero totale degli agenti che un run lungo può creare. Non usarlo per dimensionare la storia visualizzata.

## 3. Esperienza proposta: un'unica Semantic Map, tre livelli

I livelli sono navigazione interna della stessa scheda, non tre motori grafici né sostituti del Gantt.

### L0 — Overview del run

- Gruppi per fase e scope/funzione, con occorrenze distinte; nessuna fusione di fasi o label ripetute.
- Ogni gruppo riporta conteggi per stato, lavoro attivo, errori, attese, costo/token disponibili e copertura.
- I gruppi completati partono compatti; quelli attivi o con criticità vengono evidenziati. Centinaia di successi non devono nascondere un errore recente.
- Barra «Richiede attenzione»: checkpoint, errore, budget esaurito, attesa child, assenza di eventi oltre soglia. «Nessun evento da X» è un indizio, non una diagnosi di deadlock.
- Toggle semantici: **Struttura** mostra appartenenze/fasi; **Dipendenze registrate** mostra flusso e attese comprovate. Un'assenza di archi causali non significa agenti indipendenti.
- Le fasi dichiarate ma non osservate restano «non ancora osservate», non vengono inventati agenti futuri.

### L1 — Scope / fase / ramo

- Espansione del gruppo e breadcrumb; parent-child reali, agenti, controlli e scope annidati.
- Filtri per stato, ruolo, modello, tool, fase, periodo e tentativo; ricerca su **tutto il perimetro conservato**, non solo sugli SVG montati.
- Raggruppamenti conservano conteggi e endpoint esterni: «12 relazioni verso altri gruppi» è espandibile, non sono archi persi.
- Focus «attese a monte» / «operazioni a valle» solo sulle relazioni registrate; indicare se la catena è parziale.
- Per pipeline: overview per stage con drilldown per item; non disegnare ogni combinazione in un unico enorme diagramma.

### L2 — Agente / subagent / tentativo

- Selettore di tentativo e contesto sessione/turn, stato, modello, timing/accounting disponibili e disponibilità risultato.
- Tool call visualizzate per turn osservati, con conteggi, nome, stato, durata e ordinali di presentazione. Una call senza risultato rimane non conclusa/ignota secondo l'evidenza, anche se l'agente è concluso.
- Stesso messaggio può raggruppare più invocazioni; chiamarle «stesso turn», non «eseguite in parallelo» senza timing/evidenza. Non inventare branch/join di runtime.
- Paginazione/espansione per la storia; ricerca di errori anche nelle pagine vecchie. Nessun tetto di 16 tool call del run.
- Click seleziona e mostra dettagli sintetici; pulsanti espliciti «Apri evento», «Vai al Gantt», «Apri controlli». Preferire comandi accessibili al solo doppio click.
- Navigazione valida anche per subagent standalone e run terminati ancora disponibili al publisher. La chiusura di un processo non cancella la storia dal record.

### Schema UI indicativo, non screenshot di prodotto

```text
Timeline | Semantic Map
Run > Fase 3 > Scope verifica          Live / stale · aggiornato …
Ricerca nel run…  [Errori] [Attese] [Tool]  [Struttura | Dipendenze]

Richiede attenzione: 1 checkpoint · 2 errori · 1 attesa child

[Gruppo completato: 120] ─ appartenenze / dipendenze distinte ─ [Scope attivo]
                                                               ├ Agente A: running
                                                               ├ Agente B: waiting → child C
                                                               └ Agente D: failed → tentativo 2

[Fit] [+] [-] [Ricentra selezione] [Minimappa]      Dettagli / Copertura
```

## 4. Archify: sfruttare il viewer senza fingere che sia un runtime di workflow

### Profilo consigliato

- Mantenere inizialmente la revisione pinned `9e35d2b0b39b155553ba9fcfe0b4f2a5198dd993`; nessun aggiornamento upstream automatico.
- **Blueprint come preset iniziale proposto**, per leggibilità operativa, più Classic selezionabile. Tema chiaro/scuro del parent, card e badge coerenti con le variabili del preset: eliminare il dark hardcoded sui nodi.
- Materializzare preset e tutti i placeholder/i18n necessari al profilo. Testare assenza di token non risolti nelle superfici visibili/accessibili.
- Rendere disponibili pan/zoom/Fit, ricerca, focus dei vicini, dettaglio e minimappa. La ricerca globale appartiene alla query Trajectory; Finder gestisce la scena materializzata dopo aver caricato il risultato.
- Riutilizzare Focus/Camera/Finder; Radar/Lens solo dopo prove di aggiornamento delle loro cache per insert/remove/expand. I kind devono restare workflow/agent/tool ecc.: non trasformare gli agenti in «backend» solo per soddisfare una legenda upstream.
- Non togliere `embed=1` alla cieca. Un profilo operativo controllato deve esporre solo le capacità provate, mantenendo sandbox/CSP e lifecycle. Se serve adattare l'embed, farlo con patch localizzate e manifest di capacità supportate.
- Story Trail, animazioni decorative, recording e source-evidence esterno sono fuori dal nucleo. Una funzione utile e funzionante vale più di dieci pulsanti non supportati.

### Scelta del layout — decisione tecnica obbligatoria prima della migrazione

Fonti: [Workflow renderer](https://github.com/tt-a1i/archify/blob/9e35d2b0b39b155553ba9fcfe0b4f2a5198dd993/archify/renderers/workflow/README.md) e [contratti Viewer](https://github.com/tt-a1i/archify/blob/9e35d2b0b39b155553ba9fcfe0b4f2a5198dd993/viewer/README.md).

Il renderer workflow Archify v2 ha lane, gruppi, fasi, geometria misurata e routing, **ma usa ranghi logici `col` 0..5 e un compilatore per documenti generati**. Non è un motore live illimitato pronto da collegare a Trajectory.

**Correzione rispetto alla prima stesura enhanced:** il compilatore upstream è una fonte di confronto, non un componente da importare. La soluzione resta shell Archify standalone + adapter/rendering browser leggeri. Non introdurre CLI, fs, validator, generatori o un motore grafico aggiuntivo; non chiamare un generatore Node a ogni tick.

H0 verifica un layout gerarchico circoscritto alla **scena materializzata**: contenitori per fase/scope, lane per rami, livelli derivati dai collegamenti comprovati, card misurate e routing ortogonale semplice con clearance. La scalabilità deriva soprattutto da gruppi, drilldown e pagine, non da un solver generalista su 100.000 nodi. Conservare gli assunti DOM e le interazioni già presenti nella shell Archify con patch localizzate e verificabili.

Confrontare due presentazioni leggere dello stesso modello (overview per gruppi e focus locale di vicinato), non due librerie/renderer installati. Includere pipeline con più di sei stage: i ranghi del generatore Archify non limitano né i dati né la navigazione dell'integrazione.

Se il profilo non supera leggibilità, stabilità e budget, registrare il limite e rivedere raggruppamenti/perimetro visuale. Non importare automaticamente un altro motore, accrescere il bundle senza revisione o dichiarare equivalente una nuova griglia priva di utilità.

Invarianti comuni:

- Dimensioni dei nodi misurate; label multilinea leggibili, dettagli lunghi nell'inspector.
- Nodi non sovrapposti; archi non attraversano nodi estranei. Incroci inevitabili possono essere segnalati, non confusi con connessioni.
- Stati/contatori non causano relayout. Cambi strutturali riguardano il gruppo interessato; selezione e camera restano stabili.
- Retry/ritorni non spezzano il ranking. Una relazione ciclica reale non si elimina per soddisfare un DAG: usare componente ciclica/gruppo o arco di ritorno; gli endpoint invalidi invece producono diagnostica.
- Pulsante «Riordina» per una ricomposizione globale volontaria; nessun movimento continuo delle card durante la lettura.

## 5. Contratto dati: separare fatti, interpretazione e geometria

Tre modelli distinti, con identità condivise:

1. **Inspection model:** entità, fatti e copertura provenienti dal runtime/storage; nessuna posizione SVG.
2. **View model:** filtri, gruppi/aggregati e perimetro richiesto. Non è una nuova verità persistita del workflow.
3. **Scene model:** nodi/archi visibili, geometria e riferimenti risolvibili. Può contenere un gruppo da 1.000 elementi senza materializzarli tutti.

Contratto concettuale da finalizzare in H1:

```text
EntityRef = target + operation/agent identity + attempt/session + source event identity
Relation = id + from + to + kind + evidenceRef
Coverage = source revision + retained range + loaded range + known totals
           + unknown totals + gaps + truncation/retention reason
ViewRequest = target + scope + filters + detail level + cursor + byte budget
ViewResponse = revision + entities/aggregates + relations + coverage + nextCursor
```

- ID strutturali e replay esistenti restano immutati; non usare posizione, label o indice della pagina come chiave durevole.
- Riferimento tool qualificato per sessione/tentativo/turn quando necessario; stessa call ID in tentativi diversi non si fonde. Duplicati ambigui restano non navigabili finché non risolti con evidenza.
- Revisioni transcript esistenti trattate come token di uguaglianza, non contatori monotoni. Revisioni di pagina/scena sono un contratto distinto.
- Tipi di arco distinguono `contains`, `invokes`, `produces`, ordine osservato, dependency, attesa, fork/join registrato e retry. La posizione a destra non certifica una dipendenza.
- Mantenere gli stati reali, inclusi `waiting_for_child`, `awaiting_input`, `pausing`, `budget_exhausted`, cancellato e interrotto. Non trasformare ogni attesa in unknown o budget esaurito in semplice failure.
- Copertura per entità/storia/causalità/timing: separare «aggregato o fuori viewport», «non ancora caricato», «non registrato», «retention/oversized». Evitare un generico «Partial graph» sempre acceso e senza spiegazione.

### Inventario delle fonti persistite — prima di proporre nuovi dati

Non esiste necessariamente un unico file di sessione che racchiude tutto. La sessione Pi chiamante contiene invocazioni/risultati del tool workflow; gli artefatti del run conservano lo stato operativo; gli agenti possono avere sessioni Pi distinte, anche per tentativo o continuità.

| Fonte | Contenuto già recuperabile e limite |
| --- | --- |
| `state.json` | Agenti, parentela, structural path, phase history, tentativi, accounting, retry, stato e riferimenti alle sessioni. È uno snapshot aggiornato, non la cronologia di ogni transizione. |
| `snapshot.json` / `workflow.js` | Input/configurazione e script esatto eseguito. Lo script descrive il programma ma non prova quale ramo sia stato eseguito; non rieseguirlo per disegnare la mappa. |
| `journal.json` | Operazioni completate per percorso e valore, checkpoint in attesa/risolti e decisioni pertinenti. `CompletedOperation` contiene `path` e `value`, non un timestamp di ogni avvio/fine né un DAG completo. |
| `ownership.json` | Snapshot di ownership parent/child e stato; fonte di correlazione, non log di ogni attesa dello scheduler. |
| `agentSessions` / `attemptDetails[].session.locator` | Riferimenti alle sessioni native. `RunStore.agentSessionFiles()` segue già la lineage retry per operazioni journaled, ma seleziona le sessioni riuscite: per ispezionare fallimenti/vecchi tentativi occorrono anche tutti i locator conservati nei record. |
| Sessioni Pi JSONL degli agenti | Messaggi, tool call e tool result con identità; timing custom `pi-workflows:tool-timing` quando registrato. Leggere la storia disponibile, non solo la coda oggi esposta da Trajectory. Rispettare branch, tentativo e semantica delle entry; non fondere ogni riga in un'unica sequenza attiva. |
| Artefatti standalone | `status.json`, `request.json`, `result.json`, `failure.json` e locator delle sessioni: stessa strategia di lettura, con ownership del subagent. |
| Sessione Pi chiamante | Collegamenti fra invocazione workflow/subagents e risultati/ricevute; fonte complementare, non sostituto dei transcript degli agenti. |

Il tail di **2 MiB / 400 entry non-timing** e la scelta dell'ultimo tentativo sono limiti del **reader Trajectory attuale**, non prova che gli eventi precedenti siano stati cancellati. Distinguere sempre limite di lettura, limite di trasporto e dati effettivamente non conservati. La verifica qui è sui contratti/codice: la completezza di un run concreto va controllata sui suoi artefatti.

### Fonti riutilizzate nel modello

| Dato | Fonte e cautela |
| --- | --- |
| Fasi e scope | `RunRecord.phaseHistory`, `snapshot.phases`, `structuralPath`, `parentBreadcrumb`; verificare parità con `host-phases.ts`. Fase precedente non prova che ogni sua attività sia terminata. |
| Parent/child | `AgentRecord.parentId`; stessa appartenenza al run, niente inferenze da nomi. |
| Costo/token/durata | Accounting e timing già registrati; distinguere agent/tentativo, somme cumulative e missing. Non sommare insieme il totale agente e i suoi tentativi. |
| Checkpoint/budget/shell | `awaiting`, budget/usage/events e shell activity esistenti; nomi/stati nel viewer, prompt e contesto sensibile nel parent. |
| Tool live | Metadata `toolCalls`/progress e timing, più transcript su richiesta; non dipendere dall'apertura preventiva dell'inspector. |
| Storia | RunStore/status completo per i tentativi; session locator risolto dal publisher, non percorso passato dal browser. |
| Retry/replay | `retry.sourceRunId`, lineage e completed/incomplete paths, più tentativi registrati; `parentRunId` da solo indica anche riuso worktree. |

### Ricostruzione read-only e lacune effettive

Prima costruire correlazioni deterministiche fra le fonti sopra:

- run → operation path → agente → tentativo/sessione → tool call → tool result;
- parent/child da ID registrati e ownership; richieste `get_subagent_result({id})` ed esiti correlati, quando presenti, aggiungono evidenza sul child interessato;
- fasi/scope da metadata registrati, retry da provenance e risultati journaled, checkpoint da journal;
- estrarre soltanto ID e campi strutturali allowlisted di tool noti nel reader fidato: argomenti/prompt/output completi non devono attraversare il bridge per ricostruire una relazione;
- mantenere una distinzione fra relazione comprovata, appartenenza strutturale, ordine osservato e informazione indisponibile. Un evento tool senza risposta non prova da solo un deadlock né l'inizio esatto dell'attesa dello scheduler.

Per ogni requisito classificare il dato come **registrato e già esposto**, **registrato ma non esposto**, **ricostruibile per join documentato**, oppure **non ricostruibile dalle fonti conservate**. Solo l'ultima categoria può motivare H3.

Un file `state.json` aggiornato e una mappa di risultati nel journal non sono automaticamente uno storico di ogni transizione. Potrebbero mancare, per esempio, l'istante preciso di un join interno o la successione completa degli ingressi/uscite dalla coda. Questa eventuale lacuna non impedisce overview, tool history, ricerca, retry, costi e gran parte delle relazioni utili.

**Nessuna nuova persistenza nel nucleo enhanced.** L'indice read-only è derivato e ricostruibile. Non creare sidecar/event log aggiuntivi per duplicare sessioni, stati o risultati già presenti. Se dopo H2 emerge un dato indispensabile non ricostruibile, H3 presenta separatamente campo mancante, esempio concreto, beneficio e costo della minima estensione; richiede approvazione prima di toccare il runtime.

Qualunque H3 approvata deve coprire entrambi i percorsi worker/funzioni registrate quando pertinenti, preservare replay/ordine/cancellazione, dichiarare costo anche a mappa chiusa e trattare gap/crash senza falsa completezza. Non promettere comunque un DAG completo di JavaScript arbitrario e non eseguire il workflow o un LLM per inventarlo.

## 6. Scalabilità: budget di vista, non amnesia del run

### Profili da verificare

Obiettivi proposti, non capacità già dimostrate. La numerosità totale non coincide con nodi SVG contemporanei.

| Profilo | Dataset di prova | Esperienza richiesta |
| --- | --- | --- |
| S — quotidiano | 50 agenti, 1.000 tool call, 5 fasi, retry e checkpoint | Overview immediata e drilldown senza tagli artificiali. |
| M — lungo | 300 agenti, 20.000 tool call, 50 scope, 100 relazioni registrate | Tutte le entità conservate raggiungibili; anomalie e ricerca globali; tool history paginata. |
| L — stress | 1.000 agenti, 100.000 tool call, 500 scope, 3.000 relazioni | Overview aggregata, nessun freeze; scansione iniziale cancellabile con progresso, memoria bounded. |

Per tutti i profili: includere label ripetute/lunghe, Unicode, oltre otto tentativi, fallimenti all'inizio e alla fine, sessioni mancanti, file troncati e generazioni sostituite.

### Esplorazione completa senza materializzazione completa

La topologia esplorabile è quella documentata dalle fonti conservate: agenti, scope, tentativi, tool call e collegamenti supportati. Non è un unico SVG con tutti gli eventi e non è un DAG causale inventato. Il dettaglio dei payload resta nell'inspector autorizzato; non spedire tutti i dati sensibili al viewer per renderli navigabili.

1. **Overview:** una card può rappresentare «fase Verifica: 120 agenti, 2 errori, 5 attivi». Il conteggio distingue totale noto, porzione caricata e dato incompleto. Gli errori non scompaiono quando il gruppo è chiuso.
2. **Espansione:** clic sul gruppo mostra agenti/sottogruppi; se non entrano nella scena, apre un sottoscope o una pagina, lasciando breadcrumb e riepilogo del contesto.
3. **Focus agente:** tentativi e gruppi di turn; espandere un turn rivela le sue tool call. Migliaia di call si esplorano per pagina/periodo/filtro, non tramite migliaia di card simultanee.
4. **Ricerca globale su richiesta:** se l'elemento non è nella cache, il parent richiede pagine/ricerca sui record conservati. Il risultato contiene ID e percorso; il viewer apre i gruppi necessari e porta al nodo, anche se inizialmente fuori viewport.
5. **Archi fra gruppi:** rappresentarli come collegamenti aggregati con conteggio/tipo e accesso agli endpoint. Espandendo un lato, mantenere indicatori dei collegamenti esterni; un gruppo chiuso non cancella le relazioni.
6. **LOD/viewport:** a zoom lontano si mostrano gruppi e conteggi, a zoom vicino dettagli del sottografo già caricato. Solo gli elementi visibili o immediatamente vicini vengono montati nel DOM; la minimappa usa il riepilogo, non duplica tutti i nodi nascosti. Zoom da solo non scarica l'intera storia.
7. **Live stabile:** gli stati aggiornano card/aggregati senza cambiare posizioni; inserimenti/removal modificano il sottoscope pertinente. Pin/focus e breadcrumb sopravvivono a paging/aggiornamenti finché il riferimento resta valido.
8. **Memoria bounded:** scaricare dalla memoria una pagina significa poterla rileggere, non cancellarla dallo storage. Ogni limite di vista offre un modo esplicito di proseguire; eventuali dati non conservati sono dichiarati separatamente.

Esempio: `Run → Verifica (120 agenti) → agente 87 → tentativo 2 → turn 34 → chiamata read → evento nel transcript`. Tutti i passaggi usano ID qualificati e la stessa shell live, senza nuovo caricamento del viewer a ogni click.

### Politica proposta

- Overview intorno a 100–250 nodi visibili; massimo iniziale di scena 500 nodi / 1.500 archi, rivedibile con misure. È un **budget locale**, non il limite del workflow.
- Espandere un gruppo troppo grande apre un sottoscope o una pagina; non rimuove silenziosamente gli altri agenti. Anche senza raggruppamenti naturali, creare pagine/range dichiarati con conteggi.
- Nessun «primi N agenti»: errori/attivi/attese devono essere scoperti globalmente con query/summary e mantenere un indicatore anche se aggregati.
- Conteggi totali esatti solo se la fonte è stata interamente enumerata; durante scansione usare «almeno N / analisi in corso». Search negativo su dati parziali non significa «non esiste».
- Payload bridge entro 512 KiB per messaggio **compreso envelope**, paging/riduzione dettaglio prima della serializzazione completa. Budget di pagina metadata iniziale 256 KiB e massimo 200 record, quello che si raggiunge prima: un cursore rende accessibili i successivi.
- Cache di ispezione bounded e per revisione: obiettivo iniziale 32 MiB di payload stimato / LRU; misurare heap reale separatamente. Eviction ricarica una pagina, non perde la storia sorgente. Proteggere selezione e contesto minimo.
- Una richiesta pesante di ispezione attiva per vista, pending sostituibile; i filtri nuovi cancellano il lavoro precedente. Quote aggregate per publisher per impedire che molte tab aggirino il limite.

### Caricamento lungo tutta la catena

```text
RunStore + ownership + journal + sessioni Pi già persistite
           │ lettura autorizzata / query bounded / revisioni
publisher Trajectory ─ server e WebSocket esistenti ─ main app
                                                      │ ViewRequest filtrata
                                                      │ MessagePort privata
                                                      ▼
                                           Archify + scena visibile
```

Riusare il canale RPC esistente; estenderlo solo dove serve paginazione/ispezione capability-negotiated (`summary`, `scope`, `calls`, `search`, `locate` sono nomi proposti). **Le risposte sono record/metadata di sorgente e copertura, non un grafo generato lato Node:** la trasformazione in nodi/archi e aggregati visuali resta nell'adapter browser del viewer. Non aprire un secondo socket e non passare il vecchio snapshot multi-MB al child. Query e indici derivati sono attivati esclusivamente dalla mappa aperta e dalle sue richieste, mai mantenuti preventivamente per ogni workflow.

- Il parent è l'unico dispatcher: traduce l'intento del viewer in query allowlisted del target attuale, con rate limit. `inspect` è read-only e non abilita shell, file arbitrari o workflow actions.
- Il server correla browser, publisher, request ID, revisione e generazione come per le RPC esistenti; non incorpora un proprio database di run.
- Il publisher controlla ownership cwd/session/run/agent/attempt e risolve i file conservati. Usare `paths.ts` per identità fisica; mai un path libero proveniente dal child.
- La prima apertura non deve scansionare tutti i transcript. Overview dai metadata; storia e ranking globale tool possono richiedere una scansione incrementale su richiesta, con progresso e annullamento.
- Leggere JSONL in streaming/chunk con limiti di record, checkpoint di offset e righe incomplete. Pagine dei vecchi tentativi, navigazione bidirezionale e locate per entry ID o locator interno qualificato dal file/revisione. Nessun caricamento dell'intero file in memoria.
- Indice derivato effimero/on-demand, non riscrittura dei transcript. Append, rotazione, troncamento, branch di sessione e sostituzione file invalidano cursori in modo esplicito. Un cursor stale produce resync, non mix di revisioni.
- Terminale ma publisher connesso: storia esplorabile; publisher disconnesso: ultimo dato marcato stale, niente query nuove. Riapertura recupera solo dati realmente persistiti; retention/deletion mostrata, non nascosta.

### Aggiornamenti live

Separare `structureRevision`, `statusRevision` e revisione storia. La scena conserva layout sui soli stati. Un snapshot per **scena selezionata** resta sufficiente all'inizio; delta sono ammessi solo se le misure lo richiedono.

Non usare «latest wins» per perdere pagine di una stessa risposta o fatti storici: la coalescenza vale per aggiornamenti sostituibili di stato. Le pagine hanno request/cursor propri. Se introdotti delta, richiedono baseRevision, tombstone, ACK e recupero tramite snapshot atomico in caso di gap.

## 7. Valore operativo e parità utile con Mermaid

| Funzionalità | Minimo enhanced |
| --- | --- |
| Struttura run | Fasi/scope/parentela, occorrenze distinte e tutti gli agenti conservati accessibili. |
| Dettaglio invocazioni | Turn osservati, correlazione call/result univoca, stato esplicito, history oltre il tail e tentativi navigabili. |
| Diagnosi | Criticità globali, attesa child/checkpoint comprovata, contesto a monte/a valle quando disponibile. |
| Tempi e costi | Ranking agent/tentativo e tool nel perimetro noto; risultati di scansioni parziali etichettati. Niente doppio conteggio di accounting o durata sovrapposta. |
| Layout/navigazione | Card leggibili, gruppi/lane, pan/zoom/Fit visibili, ricerca globale e selezione stabile. |
| Inspector | Referenza stabile verso l'evento o risultato esatto, anche dopo paging; back/forward mantiene scope e focus. |
| Retry | Lineage, tentativi, stato riusato/nuovo quando provabile; worktree reuse distinto dal retry. |
| Offline | Export operativo opzionale con perimetro e limiti dichiarati, nella fase H7. |

La vecchia Mermaid deduceva talvolta stato dei tool da quello dell'agente e branch/join dai turn: recuperare navigazione e struttura, **non** quelle inferenze come verità causali. La minimappa o un preset da soli non chiudono nessuna riga di questa matrice.

Per «collo di bottiglia»: prima offrire durata/costo e attese osservate. Un critical path richiede un sottografo causale valido con timing compatibili e copertura sufficiente; fuori da quel caso mostrare «catena osservata», non un critical path globale o una previsione.

## 8. Sequenza di implementazione e consegne

**Un owner integra e verifica.** Ogni fase produce codice, regressioni, evidenze e limiti documentati; commit atomico con messaggio descrittivo solo quando autorizzato. Non concentrare tutti i risultati in un unico commit «integrazione Archify».

### H0 — Contratto operativo e prova di layout

- Congelare baseline candidate, matrice §7 e scenari S/M/L; raccogliere walkthrough Mermaid dal vecchio codice senza ripristinarlo nel prodotto.
- Inventariare prima artefatti del run e sessioni collegate; su run reali autorizzati o fixture generate dal runtime verificare quali dati esistono oltre il tail e quali join sono già possibili. Non riversare prompt/risultati sensibili nei report.
- Prototipo visivo read-only di L0/L1/L2 su fixture realistiche, con etichetta «dati sintetici» e fonti dei fatti distinguibili.
- Verificare le presentazioni leggere del §4 sullo stesso adapter browser; inventario patch/byte e compatibilità con la scena live. Non importare il generatore Archify o nuove librerie. Includere una pipeline con più di sei stage.
- Concordare il profilo Blueprint/Classic e la leggibilità su schermi diversi; salvare screenshot e un breve walkthrough, non aprire editor o browser senza richiesta.
- **Gate:** un operatore trova errore, attesa e tool pertinente; schema dati/copertura credibile; decisione layout documentata. Se fallisce, non procedere a una nuova skin della griglia.

### H1 — Modello di ispezione e contratti end-to-end

- Definire entità/relazioni/coverage/cursori, formati nuovi versionati e compatibilità con record storici.
- Concordare fonte per ogni campo; introdurre test prima delle correzioni di stati, identità e omissioni.
- Riusare/adattare la logica pura di fasi/scope senza importare TUI/Node nel browser; parità sui medesimi fixture.
- Definire RPC read-only e negoziazione capability soltanto per record/pagine non già disponibili; publisher vecchio resta funzionante con feature unavailable esplicita. Adapter del grafo solo nel viewer lazy; nessun servizio/indice semantico eager in Node.
- Definire join e copertura delle fonti già persistite; produrre la classificazione registrato/esposto/ricostruibile/mancante. Nessun nuovo formato di storage richiesto.
- **Gate:** contratto copre storia >8 tentativi, ID duplicati, dati mancanti, gruppi chiusi e fonti incomplete; ogni relazione ha una fonte verificabile, senza pretendere che debba esistere un array `run.relations` già pronto.

### H2 — Ispezione scalabile, pagine e ricerca

- Implementare query da loader/publisher al server e parent, con ownership, abort, quote e revisioni.
- Proiezione compatta di tutti gli agenti conservati; pagine per gruppi, tool e vecchi tentativi; ricerca/locate indipendenti dalla cache UI.
- Rimuovere 16/8/16 solo insieme ad aggregazione, paging e diagnostica di copertura.
- **Gate:** errore nell'agente 299 e call 10.001 trovato e aperto nel corretto evento; non serve precaricare tutti i transcript. Profilo L cancellabile e bounded.

### H3 — Estensione runtime solo per lacune dimostrate (opzionale, fuori dal percorso critico)

- Dopo H2, elencare gli eventuali fatti indispensabili che non risultano recuperabili da state/journal/ownership/sessioni, con esempi riproducibili. L'assenza di un campo nella proiezione corrente non basta.
- Presentare la minima estensione e il costo, invece di introdurre in anticipo un event log/sidecar generalista. Richiedere approvazione separata; se non serve, chiudere H3 come «non necessaria».
- Se approvata, preservare identità di replay, ordine, cancellazione, retention e risultati; coprire crash e vecchi record senza i campi nuovi.
- **Gate:** stessi risultati/side effect con e senza estensione; ogni nuovo dato chiude una lacuna dimostrata e non duplica un'informazione già conservata. L'assenza di H3 non blocca H4–H6: la UI dichiara i dati veramente non disponibili.

### H4 — Scena gerarchica e profilo Archify operativo

- Sostituire la griglia con il layout leggero verificato; applicare viewport/LOD, gruppi e connessioni fra aggregati nel viewer standalone, non nel runtime Node.
- Attivare i comandi utili del profilo, preset e tema; refresh esplicito delle cache Archify ammesse e cleanup al cambio scope.
- Assicurare stabilità selezione/camera e zero layout sui soli aggiornamenti di stato; culling non deve cancellare la selezione logica.
- **Gate:** geometria, testi, ricerca/Fit/minimappa e focus verificati in Chrome; nessun placeholder, controlli inerti o attraversamento di nodi estranei nelle fixture di riferimento.

### H5 — Diagnosi operativa e drilldown

- Overview criticità, conteggi/costi con copertura, filtri e search globali, dettaglio tentativo/turn/call.
- Collegare selezione e locators a Gantt/transcript/inspector, con ritorno al contesto e focus tastiera.
- Collegamenti ai controlli esistenti del parent, senza nuovi privilegi né mutation via bridge.
- **Gate prodotto:** completare tutti i task del §1 sui profili S e M; attese/criticità non spariscono perché fuori dalla scena. Mostrare un vantaggio operativo rispetto alla vecchia Mermaid, non solo parità estetica.

### H6 — Accettazione integrata e candidato operativo

- Integrare i fix Windows/URL/framing/package del piano dedicato prima dei gate finali; niente writer simultanei su server/build/bridge.
- Eseguire la matrice §9 su un candidato immutabile Windows/Linux, incluse regressioni del workflow e del Gantt.
- Pubblicare nel ledger SHA, metriche, screenshot, copertura, differenze da Mermaid e limiti residui, senza cancellare i fallimenti storici.
- **Uscita:** `OPERATIONAL CORE ACCEPTED` con H0, H1, H2, H4, H5 e H6 superati. H3 non è un prerequisito: il nucleo deve funzionare sui run già registrati. Non equivale a pacchetto pubblicato o deploy.

### H7 — Report operativo offline, esplicito e successivo

- Opzione «Includi mappa operativa nel report»: snapshot del perimetro scelto, overview aggregata, criticità e riferimenti presenti, coverage e istante di cattura.
- Asset incorporati senza fetch esterni; iframe creato solo al clic, nessun WebSocket o azione mutante. Non esportare 100.000 call di default: dichiarare cosa è incluso e il peso prima dell'export.
- Run che continua durante la cattura: snapshot coerente o indicazione di revisioni non allineate; niente stato denominato live nell'export.
- Download mediato dal parent su gesto dell'utente, senza concedere popup/download arbitrari al child.
- **Gate:** report aperto offline con mappa e dettagli inclusi, nessuna richiesta di rete; Gantt/Prism/export normale non regrediti. Questa fase chiude la perdita di topologia offline, non H6.

### H8 — Filtri di visualizzazione della Semantic Map (TODO, richiesto dall'owner, non avviato)

Richiesta: poter nascondere o abilitare elementi e funzioni della mappa, per esempio nascondere i nodi `assistant`. Da eseguire dopo l'accettazione della mappa attuale; nessun codice scritto finora.

- **Pannello filtri in stile paper** nella toolbar della mappa (accanto al pager `‹ Agents … ›`), con controlli della UI Trajectory (`--bg-3`, `--line`, serif/mono). Stato per sessione/target, persistito solo localmente (es. `localStorage` del parent), mai inviato al runtime.
- **Tipi di nodo** attivabili singolarmente: `system`, `user` (prompt e solleciti), `assistant`, `tool`, `result`; card agente sempre visibile. Nascondere un tipo ricollega la sequenza (freccia dal precedente visibile al successivo visibile, stile «salto») e conta i nodi nascosti nel box (`3 assistant nascosti`).
- **Tool:** filtro per nome (es. solo `edit`, `bash`) e «solo chiamate fallite»; i gruppi `×N` restano coerenti (conteggio filtrato e totale).
- **Agenti:** filtro per stato (running, failed, completed, queued), per fase e per scope `parallel`; ricerca per label. Interazione con la paginazione: il filtro si applica prima della pagina (le 16 per pagina sono quelle che passano il filtro), il pager mostra «N di M filtrati».
- **Livelli/funzioni opzionali:** frecce di passaggio tra fasi/ondate, statistiche nei box, totali sul canvas, bagliore neon (utile anche per le prestazioni), box compressi di default sì/no e soglia (oggi 12), etichette di fase.
- **Preset rapidi:** «Solo agenti» (una card per agente con stato, conteggi e token), «Errori» (solo agenti/chiamate con failure e il loro contesto immediato), «Completo».
- **Architettura:** i filtri di presentazione restano nel viewer (come espandi/comprimi); quelli che riducono il carico (tipi di evento, agenti) si applicano nella proiezione del parent per mantenere i limiti di payload/nodi. Il bridge continua a non trasportare contenuti; nessuna nuova dipendenza.
- **Gate:** test unitari su proiezione/layout filtrati (identità stabili, ricollegamento della sequenza, conteggi), test browser su attiva/disattiva e persistenza locale, nessuna regressione di apertura (<200 ms), dei test V0-D e del ciclo apri/chiudi 50 volte; screenshot paper chiaro/scuro con preset «Solo agenti» ed «Errori».

### H9 — Grafici, statistiche di consumo e analisi dei fail (TODO, richiesto dall'owner, non avviato)

Richiesta: grafici e statistiche su come crescono contesto, token e cache, per agente oppure aggregati per tool, role, ecc., più un'analisi dei fail. Da eseguire dopo H8 (i filtri e i preset si riusano); nessun codice scritto finora.

- **Solo dati registrati.** Per turno: `usage` dei messaggi assistant nelle trascrizioni (input, output, cacheRead, cacheWrite, cost, timestamp); per agente: `accounting`, `role`, `model`, stato, `attemptDetails` con codici di errore, `startedAt`/`durationMs`; per tool: nome, esito (`isError`) e timing dai `toolResult`/timing già usati dal Gantt; fasi/ondate e scope dalla mappa. Nessuna stima dai prompt; i turni sintetici a usage zero restano esclusi come oggi per il contesto.
- **Per agente** (pannello di destra o vista dedicata, stile paper):
  - crescita del contesto turno per turno (linea), con soglia della `contextWindow` del modello quando nota e i punti di compattazione se registrati;
  - token per turno impilati: input nuovo, cache read, cache write, output; rapporto di cache hit;
  - costo cumulato e durata dei turni; marcatori sui turni con tool falliti o solleciti (`User message`).
- **Aggregati del workflow:**
  - per **tool**: numero chiamate, tasso di errore, durata media/p95, token del turno che l'ha chiamato;
  - per **role**, **model**, **fase/ondata**, **scope `parallel`**: token, cache hit, costo, durata, agenti falliti;
  - top-N agenti per costo, contesto massimo e crescita più rapida; distribuzione delle chiamate per agente (pochi/molti tool).
- **Analisi dei fail:**
  - tassonomia dai dati: errori di tool (per nome e messaggio normalizzato), codici agente (`RESULT_INVALID`, `AGENT_FAILED`, budget, cancellazioni), tentativi e retry, solleciti di riparazione;
  - per ogni fail: dove (agente, fase, turno), cosa è successo prima (ultime chiamate), se è stato recuperato (retry riuscito, `catch` nel workflow) o ha propagato;
  - riepilogo «Errori» collegato al preset H8 e alla mappa (clic → card e inspector esistenti).
- **Architettura e limiti:** aggregazione nel parent sulle trascrizioni già nella cache (stesso RPC della mappa, stessi limiti per pagina) con indicazione esplicita di copertura parziale (`≥`, «N agenti senza trascrizione»); grafici SVG generati localmente, senza librerie o fetch esterni né nuove dipendenze; nessun contenuto di prompt/argomenti/risultati, solo numeri, nomi di tool e codici. Export opzionale CSV/JSON dei numeri, mediato dal parent.
- **Gate:** test unitari sugli aggregati (conteggi, somme, cache hit, copertura parziale, esclusione dei turni sintetici), test browser dei grafici in chiaro/scuro, verifica su run reali con molti agenti e sulla simulazione mista, nessuna regressione di apertura della mappa e del Gantt; i numeri devono coincidere con quelli del Gantt e delle statistiche dei box.

### Dipendenze

La precedenza è **completamento baseline corrente + prova V0-D consegnata e visionata → conferma passaggio → H0 → H1 → H2 → H4 → H5 → H6 → H7**. W9 (deploy) non è un prerequisito dell'enhanced. **H3 è una proposta eventuale dopo l'audit/H2, non una dipendenza obbligatoria.** Prototipi layout H0 possono usare fixture, ma la prova di recupero deve leggere artefatti/sessioni prodotti dal runtime esistente senza nuova strumentazione. H6 riesegue i gate Windows/Linux anche dopo i cambi enhanced: il verde della baseline non vale automaticamente per il nuovo candidato.

## 9. Verifica e budget misurabili

### Matrice funzionale obbligatoria

- S/M/L, run e subagent; oltre 16 agenti, oltre 8 relazioni, oltre 16/200 call, oltre 8 tentativi e pipeline oltre sei stage.
- Fallimenti in gruppi chiusi e in pagine non caricate; filtri combinati; query senza risultati con fonte incompleta.
- Phase/scope ripetuti, annidamento, parent mancante, cicli reali, dipendenze mancanti, ID call duplicati, labels malevole, Unicode.
- Record storici come caso primario: dati oltre 2 MiB/400 entry ancora sul disco, sessioni di tentativi precedenti, lineage e ownership; nessuna nuova strumentazione necessaria. Retention, file mancanti/corrotti/parziali, append/rotazione, pagine scadute e cache evicted.
- Retry/resume/replay senza side effect extra e distinzione tentativo/sessione/turn; risultato esatto dal locator.
- Reconnect/publisher replacement, target switch durante query/layout, ACK lento, close prima di ready e durante scansione, hidden/visible.
- Scheda mai aperta durante un run lungo: zero richieste asset, adapter, index/scansioni/serializzazioni mappa e timer dedicati. Dopo close: richieste annullate/risposte obsolete ignorate, cache esclusive rilasciate; nessun effetto su altre tab o cache condivise.
- Scenario oltre i limiti della scena: raggiungere ogni elemento conservato tramite gruppi/pagine/search, verificando anche gli archi fra gruppi; nessun taglio definitivo o scansione globale implicita dovuta al solo zoom.
- Run fallito, stopped, paused, pausing, awaiting_input, waiting_for_child e budget_exhausted senza normalizzazioni ingannevoli.
- Sandbox/CSP/XSS, query abusive, target altrui, path traversal, cursor contraffatti e input troppo grande; nessuna azione dal child.
- Tastiera, focus, screen-reader equivalente via elenco/tabella, reduced motion e contrasto in entrambi i temi. Desktop 1280/1920, laptop e viewport stretta con drawer, non card illeggibili ridotte all'infinito.

### Obiettivi prestazionali proposti

Conservare i budget originari ove pertinenti. Numeri nuovi sono obiettivi di progetto da misurare in H0, non risultati o licenza per ampliare soglie dopo un fallimento.

| Misura | Obiettivo e protocollo |
| --- | --- |
| Primo overview S/M | p95 ≤1 s da clic a scena utile, non soltanto ready; almeno 50 aperture, hardware/browser/cache dichiarati. |
| Aggiornamenti stato ordinari | p95 ≤100 ms da stato accettato dal parent a stato visibile, inclusa attesa bridge, a ~1 Hz. Zero relayout. |
| Burst | Max 4 invii scena/s, un attivo + newest pending, ultimo stato converge entro 1 s dal termine del burst. Non promettere 100 ms per ogni update sostituito. |
| Espansione/ricerca M già indicizzata | p95 ≤300 ms; prima scansione mostrata come in corso, non nascosta in questo benchmark. |
| Layout locale ≤500 nodi | Budget iniziale p95 ≤300 ms, nessun task UI non interrompibile >50 ms; se non fattibile valutare worker locale e variazione CSP/artifact separatamente. |
| Profilo L | Risposta di progresso/cancellazione ≤200 ms; niente scansione full-file ripetuta a ogni tick; memoria non proporzionale alle 100.000 call. |
| A mappa chiusa | 0 richieste/view query/scansioni/layout/timer dedicati; Gantt invariato. Eventuali letture già in volo annullate/ignorate e risorse rilasciate. |
| Costo runtime | Nucleo read-only: nessuna nuova scrittura di metadata e nessuna modifica dello scheduling. Solo per H3 separatamente approvata: target iniziale ≤5% overhead mediano / ≤10% p95 sul workload deterministico, includendo scritture e code; non nasconderlo nella latenza provider. |
| Asset/package | Revisione obbligatoria oltre 1 MiB raw dei tre asset, o costo significativo del riuso upstream; tarball e HTTP distinti. Nessuna dipendenza o quarto asset implicito. |
| Lifecycle/heap | 10 warm-up + 50 cicli, 10 minuti update e 60 minuti endurance M; conteggi risorse stabili, cache bounded, heap dopo GC confrontato al controllo. |

Le misure non concorrano con build/altre suite. Per heap fissare la tolleranza dal rumore del controllo prima del candidato, misurare parent e frame e diagnosticare retaining paths. Nessun leak applicativo giustificato perché «piccolo»; log/CDP/Resource Timing del test devono essere bounded e simmetrici.

### Comandi e sicurezza dei test

Durante l'implementazione: Node dichiarato, `npm ci`, regressione focalizzata, poi `npm run check`, `npm run test:packages`, e `npm run acceptance` per cambi runtime/replay. Usare gli entrypoint portabili consegnati dal piano Windows, non wrapper personali o vecchie copie dist.

**Prima di rilanciare suite estese su Windows:** sostituire i mock editor `.sh` con fixture Node/eseguibili portabili e provare che non attivino associazioni di file dell'OS. I test non devono aprire VS Code, editor reali o browser visibili, né usare impostazioni/credenziali personali. Usare Chrome headless/CDP con profilo isolato; provider live, upload e test Herdr richiedono prerequisiti e autorizzazioni separati.

Per questo documento eseguire solo verifica documentale/diff. Non rilanciare build, test di editor o workflow a pagamento per redigere il piano.

## 10. Mappa degli interventi e criteri di arresto

Percorsi proposti, non promessa che ogni file debba essere modificato:

| Area | File/owner iniziali |
| --- | --- |
| Contratti e loader | `packages/core/src/trajectory.ts`, nuovi moduli di ispezione dedicati, `trajectory-contracts.ts`, provider in `host.ts`/subagents; preservare API preesistenti. |
| Audit delle fonti | RunStore/decoder, `execution.ts`, `host-runtime.ts`, `agent-execution.ts`: prima sola lettura per verificare ciò che viene già salvato. Cambi alla registrazione solo in H3 approvata; leggere la documentazione Pi/SDK pertinente prima di cambiare hook/session API. |
| Paging/trasporto | `trajectory/src/index.ts`, `server.ts`, test RPC e limiti; coordinamento con Windows W3/W4. |
| View/scene/bridge | `trajectory/src/semantic-map/{index,adapter,bridge,renderer,viewer}.ts`; moduli separati per aggregazione/layout solo dove necessari. |
| UI e navigazione | `trajectory/src/assets/index.html`, CSS Semantic Map; Gantt/inspector condivisi, niente copia da 5.11.2. |
| Archify/build | vendor pinned, patch/capability manifest, `scripts/build-semantic-map.mjs`; tre asset riproducibili e fingerprint versionato. |
| Export | `trajectory/src/export.ts`, browser/export/package tests soltanto nella H7. |
| Verifica | Test core/runtime/replay, trajectory e packed packages; fixture sintetiche dichiarate e workload integrati deterministici. |

Fermarsi e registrare il gate fallito quando:

- per mostrare 300 agenti occorre serializzare tutti i transcript a ogni refresh;
- search o criticità vedono solo i nodi montati;
- il renderer richiede una riscrittura generalista di Archify, l'import del suo compilatore o una nuova libreria grafica;
- adapter/grafo/layout sono spostati nel processo Node, oppure vengono creati servizi, indici o scansioni specifici anche a mappa chiusa;
- la nuova telemetria modifica replay, ordine, cancellazione o risultato del workflow;
- la UI presenta dipendenze/attese/timing come fatti senza fonte sufficiente;
- gli unici test positivi usano relazioni iniettate in fixture, non una run eseguita dal runtime;
- il profilo operativo continua a essere una griglia colorata senza drilldown/diagnosi/storia;
- Windows viene escluso, le fixture aprono editor reali o il candidato non è quello effettivamente verificato.

## 11. Consegna e decisioni da chiudere

La priorità corrente è **completare e mostrare la baseline V0-D**, non iniziare subito l'enhanced. Dopo la visione dei risultati e la conferma del passaggio, il percorso è **nucleo operativo read-only H0/H1/H2/H4/H5/H6**, poi report offline H7. H3 resta un'eventuale estensione separata. Non iniziare da nuova telemetria, animazioni o ampliamenti indiscriminati dei limiti.

Decisioni richieste con l'approvazione del piano:

1. Confermare la priorità al recupero delle fonti esistenti e all'estensione circoscritta dei loader/RPC di ispezione. Nuova registrazione runtime non è necessaria per la storia già conservata e non è implicitamente autorizzata.
2. Confermare Blueprint iniziale/Classic alternativo e i tre livelli di drilldown; H0 deve mostrarne la leggibilità prima della migrazione.
3. Validare i profili S/M/L come carichi rappresentativi; sostituirli con un run anonimizzato più aderente se disponibile, senza ridurre il requisito sotto il caso operativo reale.

H0 deve verificare il layout leggero sulla base delle prove. Viewer standalone lazy, adapter nel browser e nessuna nuova libreria sono vincoli ribaditi, non opzioni da riaprire implicitamente. Un eventuale superamento del peso richiede revisione e non autorizza una diversa architettura. Non richiedere nuovamente approvazione per Windows nativo o URL versionati: sono già scelte del piano dedicato.

Checklist finale:

- [ ] Baseline attuale completata secondo W0–W8; prova V0-D riproducibile consegnata e visionata, riscontro registrato e passaggio all'enhanced confermato.
- [ ] Entità conservate raggiungibili oltre 16/8/16; ricerca e criticità indipendenti dalla viewport.
- [ ] Viewer standalone e adapter/browser realmente lazy; zero attività ricorrente dedicata a scheda chiusa, nessuna nuova libreria o bundle Archify nel runtime Node; peso dei tre asset misurato.
- [ ] Overview utile, drilldown di scope e storia per agente/tentativo/tool verificati.
- [ ] Attese e relazioni correlate alle fonti persistite con evidenza; run storici supportati senza nuova strumentazione, lacune residue dichiarate. H3 solo se necessaria e approvata.
- [ ] Layout e comandi Archify operativi, tema e accessibilità senza placeholder.
- [ ] Navigazione al transcript/Gantt corretta e controlli mutanti confinati al parent.
- [ ] Sicurezza, replay, Windows/Linux e performance verificati sullo stesso candidato.
- [ ] Report offline H7 consegnato oppure dichiarato esplicitamente non ancora disponibile.
- [ ] Evidenze, limiti e commit per fase tracciabili; release/deploy solo con mandato separato.

**Definizione di successo:** l'operatore trova il punto critico e la sua evidenza più rapidamente che con la vecchia topologia, anche dopo migliaia di chiamate. Il risultato non si misura dal numero di moduli Archify importati o dai test di sola geometria superati.

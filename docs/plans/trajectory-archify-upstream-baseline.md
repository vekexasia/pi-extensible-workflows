# Archify: nuova base ufficiale di implementazione

Questo addendum prevale sulle osservazioni del piano ricavate dal vecchio fork.

## Decisione del proprietario

Il branch deve partire dall'ultima versione ufficiale di `vekexasia/pi-extensible-workflows`, non dalla versione precedente del fork `GregBreak`.

Verifica del 26 settembre 2026:

- Ultima release stabile GitHub: [v5.17.0](https://github.com/vekexasia/pi-extensible-workflows/releases/tag/v5.17.0), pubblicata il 24 settembre 2026.
- Commit della release: `b86636786a097fedbcf64747579aa8f8ff59d1bb`.
- `upstream/main` coincide con questo commit: nessuna scelta divergente fra ultima release e ultimo main ufficiale.
- Nuovo branch: **`feat/trajectory-archify-v5.17.0`**.
- `origin` rimane il fork `https://github.com/GregBreak/pi-extensible-workflows.git`.
- Remote `upstream`: `https://github.com/vekexasia/pi-extensible-workflows.git`.
- Il precedente branch `plan/trajectory-archify-semantic-map` è preservato, senza reset o force-push.
- Il solo commit di piano `4edd984` è stato riportato come `0d05666`. Nessun commit funzionale del fork è stato importato.
- SMART `a59e84c2-4087-4b8e-a100-4df175d7f055` è stato fermato durante la discovery read-only. Stato confermato `stopped`; nessun codice di implementazione prodotto, working tree pulito prima del cambio base.

## Differenze operative già osservate

### Nessun Mermaid da eliminare

Gli asset ufficiali sono `index.html`, `favicon.png`, `marked.min.js`, `morphdom.min.js` e `prism.min.js`. La release non include Mermaid né i pannelli del fork.

- Non riportare il commit `f94fd02` che introduceva Mermaid.
- Non creare pannelli, route o test Mermaid per poi eliminarli.
- Archify sarà il solo viewer semantico, insieme al Gantt nativo che resta predefinito.
- Mantiene valore il requisito di assenza di Mermaid operativo, ma non la checklist di rimozione di codice non presente.

### Preservare le novità ufficiali

- `AGENTS.md` ora contiene istruzioni di progetto da rispettare.
- Package e workspace sono alla versione `5.17.0`; le dipendenze Pi dichiarate sono aggiornate rispetto al fork. Non ripristinare il vecchio manifest/lockfile.
- Prism è un highlighter esistente, non un viewer concorrente: mantenerlo, compresa la sua integrazione nell'export.
- Fingerprint, server health, lock/startup e altre parti del trasporto sono cambiati: aggiungere solo l'identità minima degli asset nuovi, senza regredire alle implementazioni precedenti.
- `packages/core/trajectory/test/trajectory-browser.test.ts` contiene già un harness browser/CDP senza dipendenze npm aggiuntive. Riutilizzarlo; può ricevere il percorso browser tramite `PI_TRAJECTORY_CHROME`.
- Il build copia gli asset sia in `dist/trajectory/src/assets` sia in `dist/trajectory/assets`, e pubblica anche sorgenti. Studiare i percorsi dei consumer prima di garantire una sola copia dei tre asset nuovi. Non eliminare copie richieste dagli asset preesistenti per errore.
- Le integrazioni Herdr sono gated da `HERDR_ENV=1`: distinguere un skip previsto dall'evidenza di esecuzione reale.

### Nuova baseline di peso

Non esiste più una riduzione di 2,7 MB da Mermaid rispetto alla base scelta: **Archify comporta un incremento netto** rispetto alla release ufficiale.

- Rimangono obiettivi: soli tre asset browser nuovi, profilo essenziale, nessuna nuova dipendenza npm, nessun costo ricorrente specifico della mappa quando chiusa.
- I 774.866 byte del template upstream Archify sono una misura di un candidato, non il peso obbligatorio dell'integrazione finale.
- In F0 misurare il package ufficiale e stabilire il delta reale del candidato; in E4 misurare tarball, unpacked size, copie degli asset e trasferimento HTTP effettivo.
- Contare separatamente i byte degli asset distribuiti, eventuali input di manutenzione, codice proprio e compressione. Non confrontare il checkout CRLF con un artefatto LF come se fossero differenze funzionali.

## Epic aggiornate per SMART

1. **E0 — Fattibilità e baseline ufficiale.** Rileggere codice/test della release, provare il profilo Archify live nel sandbox e valutare il costo di manutenzione. Registrare evidenze e limiti. Il gate di arresto per fork invasivo resta valido.
2. **E1 — Viewer, adapter e renderer.** Tre asset, provenance/licenze, modello bounded e aggiornabile, patch upstream localizzate e riproducibili.
3. **E2 — Tab e bridge lazy.** Integrare nella UI ufficiale, non ripristinare quella vecchia. Distruzione dell'iframe alla chiusura e snapshot corrente alla riapertura.
4. **E3 — Server, package ed export ufficiali.** Route, fingerprint, copie asset, static-mode esplicito, mantenimento Prism; verificare assenza di Mermaid senza inventarne una migrazione.
5. **E4 — Verifica finale e documentazione.** Test mirati/browser, `npm run check`, `npm run test:packages`, package e misure. Non dichiarare verificato ciò che non è stato eseguito.

Ogni epic deve avere **un commit documentato** con obiettivo, modifiche, controlli ed eventuali limiti, più aggiornamento del ledger `trajectory-archify-implementation.md`. I writer e i commit sono sequenziali. La normale installazione delle dipendenze già dichiarate tramite `npm ci` è ammessa; non aggiungere nuove dipendenze e non includere `node_modules` o build output nei commit.

Il workflow sulla vecchia base non va riavviato tramite replay: la base di codice è cambiata. Avviare una nuova esecuzione SMART con la base ufficiale esplicitamente vincolante.

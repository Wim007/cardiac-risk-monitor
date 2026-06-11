# Claude Code – werkwijze voor dit project

## Git-workflow

- Werk **altijd direct op `main`**.
- Als een directe push naar `main` geblokkeerd wordt door branch-protection:
  1. Maak een tijdelijke feature-branch.
  2. Push de wijzigingen.
  3. Maak een pull request aan.
  4. **Merge het pull request meteen** met `mcp__github__merge_pull_request`.
  5. Sync local `main`: `git fetch origin main && git reset --hard origin/main`.
- Maak **geen draft-PR's** en laat PR's nooit open staan.
- Gebruik **nooit** een apart feature-branch langer dan één sessie.

## Taal

Communiceer met de gebruiker in het **Nederlands**.

## Project

Statische single-page app (`index.html`). Geen build-stap nodig.
Server starten: `npx serve . -p 3000`.

---

## Projectoverzicht

**Cardiac Risk Monitor** is een klinisch beslissingsondersteunend hulpmiddel (concept v0.1) voor perioperatieve hartbewaking. Het helpt anesthesiologen en cardiologen bij:
- Baselinerisico-inschatting vóór operatie (ESC 2022-richtlijnen)
- Postoperatieve troponinemonitoring en MINS-detectie
- Hemodynamische risicoanalyse (MAP, tachycardie, SIOHT)
- Automatisch gegenereerde aanbevelingen met evidence-based drempelwaarden

De app is een **pure HTML/CSS/JavaScript SPA** zonder externe afhankelijkheden, behalve Chart.js (CDN).

---

## Bestandsstructuur

```
cardiac-risk-monitor/
├── index.html                          # Hoofd-app (≈3300 regels, alles-in-één)
├── perioperative-cardiac-risk-monitor.html  # Oudere/alternatieve versie (niet actief)
├── demo-patienten-niet-cardiaal.csv    # Demo-CSV met niet-cardiale patiënten
├── package.json                        # Alleen `serve` dependency (geen build)
├── Dockerfile                          # nginx:alpine voor productie (Railway)
├── entrypoint.sh                       # Stelt nginx PORT in via omgevingsvariabele
└── .gitignore                          # node_modules/, .DS_Store
```

**Alle code zit in `index.html`** — CSS, HTML en JavaScript in één bestand. Er is geen bundler, transpiler of testframework.

---

## JavaScript-architectuur (binnen `index.html`)

De code is opgedeeld in duidelijk gelabelde secties met commentaarblokken:

### `USAGE_TRACKER`
Anonieme sessietracking via webhook.site. Geactiveerd door `WEBHOOK_URL` in te stellen. Gebruikt een image-beacon om CORS-problemen te omzeilen. Testers krijgen een `?tester=Naam`-parameter in de URL.

### `createEmptyPatient()`
Fabrieksfunctie voor een leeg patiëntobject. De structuur volgt FHIR-resourcetypen:
- `Patient` — naam, leeftijd, geslacht, dossier-ID, ASA-classificatie
- `Encounter` + `Procedure` — chirurgietype, risicocategorie, datum, afdeling, spoedstatus
- `Condition[]` — comorbiditeiten (CAD, MI, hartfalen, cerebrovasculair, perifeer vaatlijden, diabetes, nierziekte, hypertensie)
- `MedicationStatement[]` — beta-blokker, statine, anticoagulans, trombocytenaggregatieremmer, ACE-remmer
- `Observation[]` (lab) — preop hs-TnT, eGFR, hemoglobine, creatinine
- `Observation[]` (monitoring) — dagelijkse troponine/MAP/HR-arrays (1–30 dagen), hemodynamische parameters
- `dataSource` — herkomst per sectie: `'manual'` | `'import'` | `'fhir'`

### `DemoRepository`
Zes hardgecodeerde demo-patiënten (DEMO-001 t/m DEMO-006) met volledig ingevulde monitoring-data. Vertegenwoordigen drie risicocategorieën: laag, verhoogd, hoog. In fase 2 te vervangen door een API/FHIR-client.

### `RuleEngine`
Transparante, op regels gebaseerde risico-engine. **Geen ML/AI.** Drie evaluatiefuncties:

1. **`evaluateBaselineRisk(patient)`** — ESC 2022/ACC scoremodel op basis van chirurgisch risico, spoedstatus, comorbiditeiten en leeftijd. Geeft score, niveau (`laag`/`verhoogd`/`hoog`) en factor-breakdown terug.

2. **`evaluateTroponinRisk(patient)`** — Seriële hs-TnT-analyse:
   - Absolute piekclassificatie: `<14` normaal · `14–49` aandacht · `50–149` verhoogd · `≥150` zeer hoog
   - MINS-criterium (Thygesen 2018 / VISION-studie / Mol 2024): ≥20% stijging t.o.v. preop baseline én postopwaarde ≥14 ng/L
   - Trendanalyse (stijgend/dalend/stabiel/normaliserend) op basis van laatste twee waarden

3. **`evaluateHemodynamicRisk(patient)`** — MAP en hartfrequentieparameters:
   - MAP < 65 mmHg (kritiek), < 75 mmHg (aandacht)
   - Duur MAP < 65 (Mol 2024, H5: aOR 3,26 bij >2u)
   - Duur MAP < 75 (Mol 2024, H5: aOR 2,68 bij >635 min)
   - Tachycardie HR > 90 bpm (Mol 2024, H3: aOR 2,69 bij >31 min)
   - **SIOHT** (Simultaneous Hypotension and Tachycardia) > 19 min (Mol 2024, H3: aOR 4,18; sterkste predictor)

4. **`generateRecommendations(patient)`** — Aggregeert alle drie signalen en genereert geprioritiseerde aanbevelingen (urgent / hoog / matig / laag).

### `AppState`
Centrale sessiestatus. Geen persistentie (alles verdwijnt bij pagina-refresh). Bevat `currentPatient` en `sessionPatients[]`. Mutaties altijd via `AppState.setPatient(p)`.

### `UI`
DOM-renderlaag. Alle directe documentmanipulatie gaat hier doorheen. Kernmethoden:
- `renderDashboard()` — statistieken en patiëntenlijst
- `renderPatientForm(p)` — formulier invullen met patiëntdata
- `renderMonitoring(p)` — dynamische troponinetermijn (1–30 dagen)
- `renderAlerts(p)` / `renderSummary(p)` — alert-engine en artsensamenvatting
- `renderTroponinChart(p)` — Chart.js lijndiagram

---

## Navigatiestructuur (views)

De app gebruikt een sidebar met een `data-view`-attribuut en CSS-klasse `.view.active`. Beschikbare views:

| View-ID         | Inhoud                                        |
|-----------------|-----------------------------------------------|
| `dashboard`     | Overzicht alle sessie-patiënten + statistieken |
| `patient-form`  | Patiëntgegevens invoeren/bewerken              |
| `import`        | CSV-import (max. 500 rijen)                   |
| `risk-intake`   | Baselinerisicoscore berekenen                  |
| `monitoring`    | Postoperatieve troponine- en MAP-tijdlijn      |
| `alerts`        | Alert-engine uitkomsten + aanbevelingen        |
| `summary`       | Artsensamenvatting (kopieerbaar)               |
| `architecture`  | FHIR-resourcemodel en databronnen              |

---

## CSV-importformaat

De importfunctie accepteert `.csv`-bestanden (max. 500 rijen). Kolomnamen zijn **case-insensitief** en volgorde maakt niet uit:

```
patient_id, leeftijd, geslacht, operatietype, spoedoperatie,
CAD, eerder_MI, hartfalen, cerebrovasculair, perifeer_vaataandoening,
diabetes, nierziekte, hypertensie, beta_blokker,
preop_TnT, dag1_TnT, dag1_MAP, dag2_TnT, dag2_MAP, dag3_TnT, dag3_MAP
```

- `geslacht`: M / V / X
- Booleans: `1`/`0`, `ja`/`nee`, `true`/`false`
- Troponine en MAP: numerieke waarden

---

## Deployment

### Lokaal
```bash
npx serve . -p 3000
```

### Docker (productie via Railway)
```bash
docker build -t cardiac-risk-monitor .
docker run -p 3000:80 -e PORT=80 cardiac-risk-monitor
```

- `Dockerfile`: nginx:alpine, kopieert alleen `index.html`
- `entrypoint.sh`: past nginx-poort aan via `$PORT`-omgevingsvariabele
- `CACHEBUST`-ARG in Dockerfile dwingt Railway een verse build af

---

## Klinische referenties in de code

De rule engine citeert specifieke bronnen in de flagteksten:
- **ESC 2022** — chirurgisch risicomodel (laag/intermediate/hoog)
- **Thygesen 2018** — MINS-definitie (universele MI-definitie)
- **VISION-studie** (Devereaux, N=15.065) — MINS-uitkomstdata
- **Mol 2024** — proefschrift met meerdere hoofdstukken:
  - H2: MINS-prevalentie en 1-jr MACE
  - H3: SIOHT als hemodynamische predictor
  - H4: beta-blokkergebruik perioperatief (N=1468 matched pairs)
  - H5: MAP-drempelwaarden en myocardschade
  - H6: hs-TnT piekwaarden en 1-jr MACE

---

## Ontwikkelconventies voor AI-assistenten

- **Één bestand**: alle wijzigingen gaan in `index.html`. Maak geen aparte `.js`- of `.css`-bestanden tenzij expliciet gevraagd.
- **Geen build-stap**: geen npm-scripts uitvoeren behalve `npx serve`.
- **Geen persistentie toevoegen**: de app is bewust sessioneel. Geen localStorage/IndexedDB toevoegen zonder expliciete opdracht.
- **FHIR-structuur bewaken**: het interne datamodel is FHIR-geïnspireerd. Nieuwe velden toevoegen conform het bestaande patroon in `createEmptyPatient()`.
- **RuleEngine is transparant**: geen ML-logica of black-box-algoritmen invoeren. Alle drempelwaarden moeten evidence-based zijn met literatuurverwijzing in de flagtekst.
- **AppState als single source**: directe DOM → state-mutaties vermijden. Altijd via `syncField()`, `syncCondition()`, `syncMed()`, `syncLab()`, `syncMonitor()` of `syncEncounter()`.
- **Disclaimer bewaken**: de app is een conceptueel hulpmiddel, geen diagnostisch systeem. Niet verwijderen: `"Not intended as a standalone diagnostic or therapeutic system."`
- **Webhook-URL**: `USAGE_TRACKER.WEBHOOK_URL` bevat een live webhook.site-adres. Nooit leegmaken of verwijderen zonder overleg.
- **Responsief design**: bestaande media-queries respecteren (`@media (max-width: 800px)`).
- **Taal in UI**: alle gebruikersgerichte tekst is **Nederlands**. Engelstalige commentaren in JS zijn toegestaan.

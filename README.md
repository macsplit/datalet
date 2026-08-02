# NextGraph React Expense Tracker Example with RDF ORM

A complete example app demonstrating the **NextGraph RDF/Graph ORM SDK** (`@ng-org/orm`) in React.

**This fork does not use NextGraph's hosted wallet/broker.** The upstream app authenticates through an iframe to `nextgraph.eu`/`nextgraph.net`, which requires creating a wallet there. This fork replaces that piece with [`src/utils/localNgEngine.ts`](src/utils/localNgEngine.ts): a small local engine, implementing the same `orm_start_graph`/`graph_orm_update` interface the ORM expects, that persists data to `localStorage` and syncs across tabs of the same browser via `BroadcastChannel`. No wallet, no account, no network connection, no encryption or cross-device sync - everything lives in this browser only. See [`src/utils/ngSession.ts`](src/utils/ngSession.ts) for how the local session is created.

This README walks you through the features of the SDK and how to build your own NextGraph-powered application.

You can find examples for Vue and Svelte frontends and the discrete (Yjs/Automerge) ORM [here](https://docs.nextgraph.org/en/framework/getting-started/).

---

## Table of Contents

- [NextGraph React Expense Tracker Example with RDF ORM](#nextgraph-react-expense-tracker-example-with-rdf-orm)
  - [Table of Contents](#table-of-contents)
  - [Quick Start](#quick-start)
  - [Project Structure](#project-structure)
  - [Building Your Own App](#building-your-own-app)
    - [Step 1: Install Dependencies](#step-1-install-dependencies)
    - [Step 2: Initialization](#step-2-initialization)
    - [Step 3: Defining Data Shapes (Schema)](#step-3-defining-data-shapes-schema)
  - [About NextGraph](#about-nextgraph)
  - [License](#license)

---

## Quick Start

No account or wallet needed. Clone this repo:

```bash
# Clone the repository
git clone https://git.nextgraph.org/NextGraph/expense-tracker-graph-react.git
cd expense-tracker-graph-react

# Install dependencies
pnpm install

# Run the development server:
pnpm dev
```

- Open the URL displayed in the console. The app loads directly - no redirect, no auth, no iframe.
- You can open the app in a second tab to see how the data is propagated (via `BroadcastChannel`, live).
- Data persists in `localStorage`, so it survives reloads but is local to this browser only.

---

## Project Structure

```
src/
├── components/                # The app's components
├── shapes/                    # Data model definitions
│   ├── shex/
│   │   └── expenseShapes.shex           # SHEX schema (source of truth)
│   └── orm/
│       ├── expenseShapes.typings.ts     # Generated TypeScript interfaces
│       ├── expenseShapes.shapeTypes.ts  # Generated shape type objects
│       └── expenseShapes.schema.ts      # Generated schema metadata
└── utils/ngSession.ts         # NextGraph session initialization
```

---

## Building Your Own App

If you want to create your own app, clone this repo or walk through the following steps. This section describes the standard, upstream NextGraph setup (hosted wallet/broker via `@ng-org/web`). **This fork does not use `@ng-org/web`** - see the note at the top of this README and Step 2 below for what it does instead.

### Step 1: Install Dependencies

```bash
pnpm add @ng-org/web@latest @ng-org/orm@latest
# Or npm install / yarn add / ...
```

| Package             | Purpose                                 |
| ------------------- | --------------------------------------- |
| `@ng-org/web`       | Core NextGraph SDK for web applications (hosted wallet/broker - not used in this fork) |
| `@ng-org/orm`       | Core ORM utilities                      |
| `@ng-org/orm/react` | react framework-specific hooks          |

### Step 2: Initialization

`@ng-org/orm` only needs an object implementing a couple of methods (`orm_start_graph`/`graph_orm_update`) plus a session with a `session_id`, passed to `initNg()`. Upstream, `@ng-org/web` provides that object over a `postMessage` bridge to a NextGraph-controlled iframe: your app runs inside it, and `@ng-org/web`'s `init()` redirects the browser to authenticate with a wallet if you're not already inside that iframe.

This fork's [`src/utils/ngSession.ts`](src/utils/ngSession.ts) provides the same `init()`/`session`/`sessionPromise` shape, but wires the ORM to [`src/utils/localNgEngine.ts`](src/utils/localNgEngine.ts) instead - a local engine backed by `localStorage` and `BroadcastChannel`. No iframe, no redirect, no wallet. `init()` is called synchronously in [`src/index.tsx`](src/index.tsx) before the first render.

Either way, once we have a session we can load data. The session contains the info about your private, protected and public store IDs. For the sake of an example, we store the data directly in the private store document.

### Step 3: Defining Data Shapes (Schema)

NextGraph uses [SHEX (Shape Expressions)](https://shex.io/) to define your data model.
SHEX is a language to define RDF shapes. RDF (Resource Description Framework) is a way to represent data in a format that makes **application interoperability** easier. Under the hood, NextGraph comes with an RDF graph database. The ORM handles all interaction with the RDF database for you.

You can find the SHEX definitions in [`src/shapes/shex`](src/shapes/shex) and they are converted to ShapeTypes using the script `pnpm build:orm`.

For more information, see the READMEs of [`@ng-org/shex-orm`](https://docs.nextgraph.org/en/reference/shex-orm/) and [`@ng-org/orm`](https://docs.nextgraph.org/en/reference/orm/) reference.

> **Watch Out:** If you modify an object in a way that breaks any of the shape's constraints, e.g. by modifying the `@type`, the object will "disappear" from ORM perspective. The data is not deleted (in RDF all data is stored atomically) but since it does not match the shape anymore, it is not shown in the frontend. You can still modify the data with SPARQL queries.
>
> The ORM supports nested objects as well. When you delete a nested object from a parent object, **the nested object is not deleted**. Only the link from the parent object to the nested object is removed.

For more advanced data and subscription management, e.g. transactions or component-independent stores, see the TS docs of `@ng-org/orm` (especially DiscreteOrmSubscription) and the [reference](https://docs.nextgraph.org/en/reference/orm/#overview).

## About NextGraph

> **NextGraph** brings about the convergence of P2P and Semantic Web technologies, towards a decentralized, secure and privacy-preserving cloud, based on CRDTs.
>
> This open source ecosystem provides solutions for end-users (a platform) and software developers (a framework), wishing to use or create **decentralized** apps featuring: **live collaboration** on rich-text documents, peer to peer communication with **end-to-end encryption**, offline-first, **local-first**, portable and interoperable data, total ownership of data and software, security and privacy.
>
> Centered on repositories containing **semantic data** (RDF), **rich text**, and structured data formats like **JSON**, synced between peers belonging to permissioned groups of users, it offers strong eventual consistency, thanks to the use of **CRDTs**. Documents can be linked together, signed, shared securely, queried using the **SPARQL** language and organized into sites and containers.
>
> More info: [https://nextgraph.org](https://nextgraph.org)

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE2](LICENSE-APACHE2) or http://www.apache.org/licenses/LICENSE-2.0)
- MIT license ([LICENSE-MIT](LICENSE-MIT) or http://opensource.org/licenses/MIT)
  at your option.

`SPDX-License-Identifier: Apache-2.0 OR MIT`

---

NextGraph received funding through the [NGI Assure Fund](https://nlnet.nl/assure) and the [NGI Zero Commons Fund](https://nlnet.nl/commonsfund/), both funds established by [NLnet](https://nlnet.nl/) Foundation with financial support from the European Commission's [Next Generation Internet](https://ngi.eu/) programme, under the aegis of DG Communications Networks, Content and Technology under grant agreements No 957073 and No 101092990, respectively.

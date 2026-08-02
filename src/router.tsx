// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { createRootRoute, createRoute, createRouter, Outlet, Link } from "@tanstack/react-router";
import { ExpensesPage } from "./pages/ExpensesPage";
import { AboutPage } from "./pages/AboutPage";

/** Site-wide chrome (nav + content outlet), shared by every page. */
function RootLayout() {
  return (
    <div className="app-shell">
      <nav className="app-nav">
        <div className="app-nav-inner">
          <span className="app-nav-brand">Expense Tracker</span>
          <div className="app-nav-links">
            <Link to="/" activeOptions={{ exact: true }} activeProps={{ className: "active" }}>
              Expenses
            </Link>
            <Link to="/about" activeProps={{ className: "active" }}>
              About
            </Link>
          </div>
        </div>
      </nav>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}

const rootRoute = createRootRoute({ component: RootLayout });

const expensesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: ExpensesPage,
});

const aboutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/about",
  component: AboutPage,
});

const routeTree = rootRoute.addChildren([expensesRoute, aboutRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { useEffect } from "react";
import { createRootRoute, createRoute, createRouter, Outlet, Link } from "@tanstack/react-router";
import { ExpensesPage } from "./pages/ExpensesPage";
import { SettingsPage } from "./pages/SettingsPage";
import { useSettings } from "./hooks/useSettings";

/** Site-wide chrome (nav + content outlet), shared by every page. */
function RootLayout() {
  const { appTitle } = useSettings();

  // The nav brand reflects this reactively already (plain render), but the
  // browser tab title is outside React's tree - has to be pushed to it
  // imperatively whenever the configured title changes.
  useEffect(() => {
    document.title = appTitle;
  }, [appTitle]);

  return (
    <div className="app-shell">
      <nav className="app-nav">
        <div className="app-nav-inner">
          <span className="app-nav-brand">{appTitle}</span>
          <div className="app-nav-links">
            <Link to="/" activeOptions={{ exact: true }} activeProps={{ className: "active" }}>
              Expenses
            </Link>
            <Link to="/settings" activeProps={{ className: "active" }}>
              Settings
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

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([expensesRoute, settingsRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

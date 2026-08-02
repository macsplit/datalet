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
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  Link,
  useParams,
} from "@tanstack/react-router";
import { SettingsPage } from "./pages/SettingsPage";
import { TabPage } from "./pages/TabPage";
import { SchemaListPage } from "./pages/SchemaListPage";
import { SchemaEditorPage } from "./pages/SchemaEditorPage";
import { TabsManagerPage } from "./pages/TabsManagerPage";
import { BlocksBuilderPage } from "./pages/BlocksBuilderPage";
import { SettingsProvider, useSettings } from "./hooks/useSettings";
import { useTabs } from "./hooks/useTabs";
import { RuntimeIssueBanner } from "./components/RuntimeSafety";
import { MetaStoreProvider } from "./hooks/MetaStoreContext";

/** Site-wide chrome (nav + content outlet), shared by every page. */
function RootLayout() {
  const { appTitle } = useSettings();
  const { homeTab, userTabs } = useTabs();

  // The nav brand reflects this reactively already (plain render), but the
  // browser tab title is outside React's tree - has to be pushed to it
  // imperatively whenever the configured title changes.
  useEffect(() => {
    document.title = appTitle;
  }, [appTitle]);

  return (
    <div className="app-shell">
      <RuntimeIssueBanner />
      <nav className="app-nav">
        <div className="app-nav-inner">
          <span className="app-nav-brand">{appTitle}</span>
          <div className="app-nav-links">
            <Link to="/" activeOptions={{ exact: true }} activeProps={{ className: "active" }}>
              {homeTab?.title || "Home"}
            </Link>
            {userTabs.map((tab) => (
              <Link
                key={tab["@id"]}
                to="/tab/$tabId"
                params={{ tabId: tab["@id"] }}
                activeProps={{ className: "active" }}
              >
                {tab.title}
              </Link>
            ))}
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

function RootWithProviders() {
  return (
    <MetaStoreProvider>
      <SettingsProvider>
        <RootLayout />
      </SettingsProvider>
    </MetaStoreProvider>
  );
}

const rootRoute = createRootRoute({ component: RootWithProviders });

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: TabPage,
});

function RoutedTabPage() {
  const { tabId } = useParams({ from: "/tab/$tabId" });
  return <TabPage tabId={tabId} />;
}

const tabRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tab/$tabId",
  component: RoutedTabPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});

const schemaListRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/schemas",
  component: SchemaListPage,
});

const schemaEditorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/schemas/$schemaId",
  component: SchemaEditorPage,
});

const tabsManagerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/tabs",
  component: TabsManagerPage,
});

const blocksBuilderRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/tabs/$tabId/blocks",
  component: BlocksBuilderPage,
});

const routeTree = rootRoute.addChildren([
  homeRoute,
  tabRoute,
  settingsRoute,
  schemaListRoute,
  schemaEditorRoute,
  tabsManagerRoute,
  blocksBuilderRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

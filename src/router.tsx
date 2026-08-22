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
  useLocation,
  useParams,
} from "@tanstack/react-router";
import { SettingsPage } from "./pages/SettingsPage";
import { DataletsPage } from "./pages/DataletsPage";
import { ThemePage } from "./pages/ThemePage";
import { TabPage } from "./pages/TabPage";
import { SchemaListPage } from "./pages/SchemaListPage";
import { SchemaEditorPage } from "./pages/SchemaEditorPage";
import { TabsManagerPage } from "./pages/TabsManagerPage";
import { BlocksBuilderPage } from "./pages/BlocksBuilderPage";
import { SettingsProvider, useSettings } from "./hooks/useSettings";
import { useTabs } from "./hooks/useTabs";
import { RuntimeIssueBanner } from "./components/RuntimeSafety";
import { MetaStoreProvider } from "./hooks/MetaStoreContext";
import { UndoControl } from "./components/UndoControl";
import { GearIcon, HouseIcon } from "./components/icons";
import { resolveTabRouteSegment, tabRouteSegment } from "./utils/tabRoutes";
import { rememberActiveDataletTitle } from "./utils/datalets";

/** Site-wide chrome (nav + content outlet), shared by every page. */
function RootLayout() {
  const { appTitle } = useSettings();
  const { homeTab, userTabs } = useTabs();
  const pathname = useLocation().pathname;
  let currentTabSegment: string | undefined;
  if (pathname.startsWith("/tab/")) {
    const rawSegment = pathname.slice("/tab/".length);
    try {
      currentTabSegment = decodeURIComponent(rawSegment);
    } catch {
      currentTabSegment = rawSegment;
    }
  }
  const currentTab = currentTabSegment
    ? resolveTabRouteSegment(currentTabSegment, userTabs)
    : undefined;

  // The nav brand reflects this reactively already (plain render), but the
  // browser tab title is outside React's tree - has to be pushed to it
  // imperatively whenever the configured title changes.
  // Fragment anchors, which a client-side router does not give you for free:
  // the browser resolves the hash before React has rendered the target, so
  // nothing is there to scroll to. Retried across a few frames rather than
  // once, because a panel may wait on its own subscription before it exists.
  const hash = useLocation().hash;
  useEffect(() => {
    if (!hash) return;
    let frames = 0;
    let raf = 0;
    const find = () => {
      const target = document.getElementById(hash);
      if (target) {
        target.scrollIntoView({ block: "start", behavior: "smooth" });
        return;
      }
      if (frames++ < 30) raf = requestAnimationFrame(find);
    };
    raf = requestAnimationFrame(find);
    return () => cancelAnimationFrame(raf);
  }, [hash, pathname]);

  useEffect(() => {
    document.title = appTitle;
    // Recorded here rather than on the datalets page, because that page is not
    // where the title is edited. A rename followed by a switch, without ever
    // opening the list in between, must still leave the datalet nameable.
    rememberActiveDataletTitle(appTitle);
  }, [appTitle]);

  return (
    <div className="app-shell">
      <RuntimeIssueBanner />
      <nav className="app-nav">
        <div className="app-nav-inner">
          <span className="app-nav-brand">{appTitle}</span>
          <div className="app-nav-links">
            <UndoControl />
            {/* Home and Settings are fixed destinations, so they read as
                icons with the name on hover. User tabs keep their titles:
                there is no icon that could stand for an arbitrary one. */}
            <Link
              to="/"
              className="nav-icon-link"
              activeOptions={{ exact: true }}
              activeProps={{ className: "nav-icon-link active" }}
              aria-label={homeTab?.title || "Home"}
              title={homeTab?.title || "Home"}
            >
              <HouseIcon />
            </Link>
            {userTabs.map((tab) => (
              <Link
                key={tab["@id"]}
                to="/tab/$tabId"
                params={{ tabId: tabRouteSegment(tab, userTabs) }}
                className={currentTab?.["@id"] === tab["@id"] ? "active" : undefined}
              >
                {tab.title}
              </Link>
            ))}
            <Link
              to="/settings"
              className="nav-icon-link"
              activeProps={{ className: "nav-icon-link active" }}
              aria-label="Settings"
              title="Settings"
            >
              <GearIcon />
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
  const { tabs, userTabs } = useTabs();
  const tab = resolveTabRouteSegment(tabId, tabs, userTabs);
  return <TabPage tabId={tab?.["@id"] ?? tabId} />;
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

const themeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/theme",
  component: ThemePage,
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

const dataletsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/datalets",
  component: DataletsPage,
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
  themeRoute,
  dataletsRoute,
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

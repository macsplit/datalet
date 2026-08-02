import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { Tab } from "../shapes/orm/metaShapes.typings";
import { useBlocks } from "../hooks/useBlocks";
import { useTabs } from "../hooks/useTabs";
import { useWidgets } from "../hooks/useWidgets";
import { PencilIcon, TrashIcon } from "../components/icons";
import { collectDescendantBlockIds } from "../utils/blockGraph";
import { reportRuntimeIssue } from "../utils/runtimeHealth";

function TabNameEditor({ tab, tabs }: { tab: Tab; tabs: Tab[] }) {
  const [draft, setDraft] = useState(tab.title);
  const [error, setError] = useState("");

  useEffect(() => setDraft(tab.title), [tab.title]);

  const commit = () => {
    const next = draft.trim();
    if (!next) {
      setError("Tab names cannot be empty.");
      setDraft(tab.title);
      return;
    }
    if (
      next !== tab.title &&
      tabs.some((candidate) => candidate.title.toLowerCase() === next.toLowerCase())
    ) {
      setError("Tab names must be unique.");
      setDraft(tab.title);
      return;
    }
    setError("");
    tab.title = next;
  };

  return (
    <div className="field-group builder-name-field">
      <label className="field-label" htmlFor={`${tab["@id"]}-title`}>
        Tab name
      </label>
      <input
        id={`${tab["@id"]}-title`}
        className="input"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(tab.title);
            event.currentTarget.blur();
          }
        }}
      />
      {error && <small className="danger-text">{error}</small>}
    </div>
  );
}

export function TabsManagerPage() {
  const { tabs, homeTab, userTabs, createTab, deleteTab } = useTabs();
  const { blocks, deleteBlock } = useBlocks();
  const { widgets, deleteWidget } = useWidgets();

  const handleCreate = () => {
    const usedNames = new Set(tabs.map((tab) => tab.title.toLowerCase()));
    let suffix = userTabs.length + 1;
    let title = `New tab ${suffix}`;
    while (usedNames.has(title.toLowerCase())) title = `New tab ${++suffix}`;
    createTab({ title });
  };

  const moveTab = (from: number, offset: -1 | 1) => {
    const reordered = [...userTabs];
    const [tab] = reordered.splice(from, 1);
    reordered.splice(from + offset, 0, tab);
    reordered.forEach((item, index) => {
      item.order = index + 1;
    });
  };

  const handleDelete = (tab: Tab) => {
    if (!window.confirm(`Delete the “${tab.title}” tab and all of its blocks?`)) {
      return;
    }

    let descendantIds: Set<string>;
    try {
      descendantIds = collectDescendantBlockIds(
        blocks,
        blocks
        .filter((block) => block.parentTabId === tab["@id"])
        .map((block) => block["@id"]),
      );
    } catch (error) {
      reportRuntimeIssue(error, "Tab deletion was stopped");
      return;
    }

    // Remove the navigation item first so the UI responds immediately even
    // when a large descendant tree still needs cleaning up.
    deleteTab(tab);
    userTabs
      .filter((candidate) => candidate["@id"] !== tab["@id"])
      .forEach((candidate, index) => {
        candidate.order = index + 1;
      });

    for (const widget of widgets) {
      if (descendantIds.has(widget.parentBlockId)) deleteWidget(widget);
    }
    for (const block of blocks) {
      if (descendantIds.has(block["@id"])) deleteBlock(block);
    }
  };

  return (
    <div className="page-content">
      <header className="page-hero">
        <h1>Tabs</h1>
        <p>Choose which pages appear in the navigation and in what order.</p>
      </header>
      <section className="panel">
        <header className="panel-header">
          <div>
            <p className="label-accent">Navigation</p>
            <h2 className="title">App tabs</h2>
          </div>
          <button type="button" className="primary-btn" onClick={handleCreate}>
            + New tab
          </button>
        </header>
        <div className="cards-stack">
          {homeTab && (
            <article className="builder-card">
              <div>
                <p className="label-accent">Fixed first</p>
                <h3 className="title">{homeTab.title}</h3>
                <p className="muted small-margin">
                  Home cannot be renamed, reordered, or deleted.
                </p>
              </div>
              <Link
                className="icon-btn"
                to="/settings/tabs/$tabId/blocks"
                params={{ tabId: homeTab["@id"] }}
                aria-label={`Manage blocks for ${homeTab.title}`}
                title={`Manage blocks for ${homeTab.title}`}
              >
                <PencilIcon />
              </Link>
            </article>
          )}
          {userTabs.map((tab, index) => (
            <article className="builder-card" key={tab["@id"]}>
              <TabNameEditor tab={tab} tabs={tabs} />
              <div className="builder-actions">
                <Link
                  className="icon-btn"
                  to="/settings/tabs/$tabId/blocks"
                  params={{ tabId: tab["@id"] }}
                  aria-label={`Manage blocks for ${tab.title}`}
                  title={`Manage blocks for ${tab.title}`}
                >
                  <PencilIcon />
                </Link>
                <button
                  type="button"
                  className="secondary-btn"
                  disabled={index === 0}
                  onClick={() => moveTab(index, -1)}
                  aria-label={`Move ${tab.title} up`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="secondary-btn"
                  disabled={index === userTabs.length - 1}
                  onClick={() => moveTab(index, 1)}
                  aria-label={`Move ${tab.title} down`}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="icon-btn icon-btn-danger"
                  onClick={() => handleDelete(tab)}
                  aria-label={`Delete ${tab.title}`}
                  title={`Delete ${tab.title}`}
                >
                  <TrashIcon />
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
      <Link className="secondary-btn button-link" to="/settings">
        ← Back to Settings
      </Link>
    </div>
  );
}

import { BlockRenderer } from "../components/BlockRenderer";
import { useBlocks } from "../hooks/useBlocks";
import { useTabs } from "../hooks/useTabs";

export function TabPage({ tabId }: { tabId?: string }) {
  const { tabs, homeTab } = useTabs();
  const tab = tabId
    ? tabs.find((candidate) => candidate["@id"] === tabId)
    : homeTab;
  const { blocks } = useBlocks(
    tab ? { parentTabId: tab["@id"] } : undefined,
  );

  if (!tab) {
    return (
      <div className="page-content">
        <p className="muted">{tabId ? "Tab not found." : "Loading Home…"}</p>
      </div>
    );
  }

  return (
    <div className="page-content">
      {blocks.length > 0 ? (
        <div className="section-stack">
          {blocks.map((block) => (
            <BlockRenderer block={block} key={block["@id"]} />
          ))}
        </div>
      ) : (
        <section className="panel">
          <header className="panel-header">
            <div>
              <p className="label-accent">{tab.title}</p>
              <h1 className="title">Nothing here yet</h1>
            </div>
          </header>
          <p className="muted">
            Add blocks from Settings to build this tab.
          </p>
        </section>
      )}
    </div>
  );
}

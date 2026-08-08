import { useNavigate, Link } from "@tanstack/react-router";
import { usePropertyDefs } from "../hooks/usePropertyDefs";
import { useSchemas } from "../hooks/useSchemas";
import { useBlocks } from "../hooks/useBlocks";
import { useWidgets } from "../hooks/useWidgets";
import { PencilIcon, TrashIcon } from "../components/icons";

export function SchemaListPage() {
  const navigate = useNavigate();
  const { schemas, createSchema, deleteSchema } = useSchemas();
  const { properties, deletePropertyDef } = usePropertyDefs();
  const { blocks, deleteBlock } = useBlocks();
  const { widgets, deleteWidget } = useWidgets();

  const handleCreate = () => {
    const schemaId = createSchema();
    if (schemaId) {
      void navigate({
        to: "/settings/schemas/$schemaId",
        params: { schemaId },
      });
    }
  };

  const handleDelete = (schemaId: string) => {
    const schema = schemas.find((candidate) => candidate["@id"] === schemaId);
    if (!schema) return;
    if (
      !window.confirm(
        `Delete the “${schema.name || "unnamed"}” schema, its properties, and its data blocks?`,
      )
    ) {
      return;
    }
    for (const property of properties) {
      if (property.schemaId === schemaId) deletePropertyDef(property);
      else if (property.referenceSchemaId === schemaId) {
        property.dataType = "did:ng:z:text";
        delete property.referenceSchemaId;
        for (const widget of widgets) {
          const owner = blocks.find((block) => block["@id"] === widget.parentBlockId);
          if (
            owner?.schemaId === property.schemaId &&
            widget.propertyName === property.name
          ) {
            widget.fieldType = "did:ng:z:text";
          }
        }
      }
    }
    const dataBlockIds = new Set(
      blocks
        .filter((block) => block.schemaId === schemaId)
        .map((block) => block["@id"]),
    );
    for (const widget of widgets) {
      if (dataBlockIds.has(widget.parentBlockId)) deleteWidget(widget);
    }
    for (const block of blocks) {
      if (dataBlockIds.has(block["@id"])) deleteBlock(block);
    }
    deleteSchema(schema);
  };

  return (
    <div className="page-content">
      <header className="page-hero">
        <h1>Schemas</h1>
        <p>Define the record types that data blocks can display and edit.</p>
      </header>
      <section className="panel">
        <header className="panel-header">
          <div>
            <p className="label-accent">Data model</p>
            <h2 className="title">User-defined schemas</h2>
          </div>
          <button type="button" className="primary-btn" onClick={handleCreate}>
            + New schema
          </button>
        </header>
        <div className="cards-stack">
          {schemas.length > 0 ? (
            schemas.map((schema) => {
              const propertyCount = properties.filter(
                (property) => property.schemaId === schema["@id"],
              ).length;
              return (
                <article className="builder-card" key={schema["@id"]}>
                  <div>
                    <p className="label-accent">Schema</p>
                    <h3 className="title">{schema.name || "Unnamed schema"}</h3>
                    <p className="muted small-margin">
                      {propertyCount}{" "}
                      {propertyCount === 1 ? "property" : "properties"}
                    </p>
                  </div>
                  <div className="builder-actions">
                    <Link
                      className="icon-btn"
                      to="/settings/schemas/$schemaId"
                      params={{ schemaId: schema["@id"] }}
                      aria-label={`Edit ${schema.name || "schema"}`}
                      title={`Edit ${schema.name || "schema"}`}
                    >
                      <PencilIcon />
                    </Link>
                    <button
                      type="button"
                      className="icon-btn icon-btn-danger"
                      onClick={() => handleDelete(schema["@id"])}
                      aria-label={`Delete ${schema.name || "schema"}`}
                      title={`Delete ${schema.name || "schema"}`}
                    >
                      <TrashIcon />
                    </button>
                  </div>
                </article>
              );
            })
          ) : (
            <p className="muted">No schemas yet. Create one to get started.</p>
          )}
        </div>
      </section>
      <Link className="secondary-btn button-link" to="/settings">
        ← Back to Settings
      </Link>
    </div>
  );
}

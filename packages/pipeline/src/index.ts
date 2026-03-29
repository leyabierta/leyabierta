export * from "./country.ts";
export * from "./git/message.ts";
export * from "./git/repo.ts";
export * from "./models.ts";
export * from "./pipeline.ts";
export * from "./transform/frontmatter.ts";
export * from "./transform/markdown.ts";
export * from "./transform/markdown-linter.ts";
export * from "./transform/slug.ts";
export * from "./transform/xml-parser.ts";

// Country registrations (side-effect imports)
import "./spain/index.ts";

// Re-export country-specific modules
export * from "./spain/index.ts";

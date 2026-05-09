
/**
 * Surgical XML Patch Logic for Workspace Synthesizer
 * This test replicates and verifies the regex and string manipulation logic
 * implemented in app/store/workspace.ts
 */

function applyPatches(originalContent: string, llmOutput: string): string {
  let cleanedContent = llmOutput.trim();
  // Remove markdown xml codeblock wrapping if model returns it
  if (cleanedContent.startsWith("```xml")) {
    cleanedContent = cleanedContent.replace(/^```xml\n/i, "");
    cleanedContent = cleanedContent.replace(/\n```$/i, "");
  }

  let newContent = originalContent;
  const tagRegex = /<(update|add)\s+header="([^"]+)">([\s\S]*?)(?:<\/\1>|$)/gi;

  let match;
  let tagsFound = false;

  while ((match = tagRegex.exec(cleanedContent)) !== null) {
    tagsFound = true;
    const action = match[1].toLowerCase();
    const header = match[2];
    const content = match[3].trim();

    let finalContent = content;
    if (!finalContent.trim().startsWith("#")) {
       finalContent = `## ${header}\n\n${finalContent}`;
    }

    if (action === "update") {
      const escapeRegExp = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const escapedHeader = escapeRegExp(header);

      const headerMatchRegex = new RegExp("(^|\\n)(#+)\\s+" + escapedHeader + "\\s*(?=\\n|$)", "i");
      const headerMatchResult = headerMatchRegex.exec(newContent);

      if (headerMatchResult) {
        const hashes = headerMatchResult[2];
        const depth = hashes.length;
        const blockRegex = new RegExp("(^|\\n)(" + hashes + "\\s+" + escapedHeader + "\\s*(?:\\n|\\r)[\\s\\S]*?)(?=(\\n#{1," + depth + "}\\s+)|$)", "i");

        if (blockRegex.test(newContent)) {
          newContent = newContent.replace(blockRegex, (match, p1) => p1 + finalContent);
        } else {
          newContent += "\n\n" + finalContent; // Fallback to add if block boundary parsing fails
        }
      } else {
        newContent += "\n\n" + finalContent; // Fallback to add if header not found
      }
    } else if (action === "add") {
      newContent += "\n\n" + finalContent;
    }
  }

  if (!tagsFound) {
    // Failsafe: Model failed to use XML tags, likely raw markdown.
    let fallbackContent = cleanedContent;
    if (fallbackContent.startsWith("```markdown")) {
      fallbackContent = fallbackContent.replace(/^```markdown\n/i, "");
      fallbackContent = fallbackContent.replace(/\n```$/i, "");
    }
    newContent += `\n\n## Unsorted Updates\n\n${fallbackContent}`;
  }

  return newContent.trim();
}

describe("Workspace Surgical XML Patching", () => {
  const baseDocument = `
# Project Alpha
## Overview
This is the overview.

## Budget
- $100 for snacks.

## Unanswered Questions
- When do we start?
`.trim();

  test("should update an existing section by exact header match", () => {
    const patch = `<update header="Budget">
## Budget
- $200 for snacks (inflation).
- $50 for drinks.
</update>`;
    const result = applyPatches(baseDocument, patch);
    expect(result).toContain("- $200 for snacks (inflation).");
    expect(result).not.toContain("- $100 for snacks.");
    expect(result).toContain("## Overview"); // Preserved
  });

  test("should add a brand new section", () => {
    const patch = `<add header="Timeline">
## Timeline
Phase 1 starts in May.
</add>`;
    const result = applyPatches(baseDocument, patch);
    expect(result).toContain("## Timeline");
    expect(result).toContain("Phase 1 starts in May.");
  });

  test("should handle headers without explicit hashes in the tag content", () => {
    const patch = `<update header="Overview">
Newly written overview without its own ## prefix.
</update>`;
    const result = applyPatches(baseDocument, patch);
    expect(result).toContain("## Overview");
    expect(result).toContain("Newly written overview");
  });

  test("should correctly identify block boundaries (not consuming unrelated sections)", () => {
    const patch = `<update header="Overview">
## Overview
Slightly updated overview.
</update>`;
    const result = applyPatches(baseDocument, patch);
    expect(result).toContain("## Overview");
    expect(result).toContain("Slightly updated overview.");
    expect(result).toContain("## Budget"); // Still exists
    expect(result).toContain("- $100 for snacks."); // Still exists
  });

  test("should respect header hierarchy (not deleting everything if its a subheader)", () => {
    const complexDoc = `
## Main
### Sub
content
## Other
content
`.trim();
    const patch = `<update header="Sub">
### Sub
New sub content.
</update>`;
    const result = applyPatches(complexDoc, patch);
    expect(result).toContain("## Main");
    expect(result).toContain("### Sub");
    expect(result).toContain("New sub content.");
    expect(result).toContain("## Other");
  });

  test("should fallback to 'add' if the header in 'update' tag does not exist", () => {
    const patch = `<update header="NonExistent">
## NonExistent
Some content.
</update>`;
    const result = applyPatches(baseDocument, patch);
    expect(result).toContain("## NonExistent");
    expect(result).toContain("Some content.");
    expect(result).toContain("## Budget"); // Original preserved
  });

  test("should use Failsafe for raw markdown without XML tags", () => {
    const rawMarkdown = `## Surprise Section
This model forgot the XML tags!`;
    const result = applyPatches(baseDocument, rawMarkdown);
    expect(result).toContain("## Unsorted Updates");
    expect(result).toContain("## Surprise Section");
  });

  test("should handle mixed updates and additions in one run", () => {
    const patch = `
<update header="Budget">
## Budget
- $0 (Free snacks!)
</update>

<add header="Conclusion">
## Conclusion
Experiment success.
</add>
`.trim();
    const result = applyPatches(baseDocument, patch);
    expect(result).toContain("- $0 (Free snacks!)");
    expect(result).toContain("## Conclusion");
    expect(result).toContain("## Overview");
  });

  test("should handle mermaid and code blocks inside patches", () => {
    const patch = `<add header="Diagram">
## Diagram
\`\`\`mermaid
graph TD;
    A-->B;
\`\`\`
</add>`;
    const result = applyPatches(baseDocument, patch);
    expect(result).toContain("\`\`\`mermaid");
    expect(result).toContain("graph TD;");
  });

  test("should handle XML tags wrapped in markdown codeblocks (common and noisy LLM behavior)", () => {
    const patch = `
\`\`\`xml
<update header="Overview">
## Overview
Cleaned via codeblock removal.
</update>
\`\`\`
`.trim();
    const result = applyPatches(baseDocument, patch);
    expect(result).toContain("Cleaned via codeblock removal.");
    expect(result).not.toContain("\`\`\`xml");
  });
});

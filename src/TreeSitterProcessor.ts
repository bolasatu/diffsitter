import Parser from 'tree-sitter';

/**
 * Position in a document (row and column)
 * Mirrors tree_sitter::Point
 */
export interface Point {
    row: number;
    column: number;
}

/**
 * Entry represents a mapping between a tree-sitter node and its text.
 * This is the unit of comparison for the diff algorithm.
 * Mirrors the Rust Entry struct from input_processing.rs
 */
export interface Entry {
    /** The node type identifier (equivalent to kind_id in Rust) */
    kindId: string;

    /** The text content this entry refers to */
    text: string;

    /** The entry's start position in the document */
    startPosition: Point;

    /** The entry's end position in the document */
    endPosition: Point;

    /** Reference to the original tree-sitter node */
    reference: Parser.SyntaxNode;
}

/**
 * The leaves of an AST vector.
 * This is used as an intermediate struct for flattening the tree structure.
 * Mirrors Rust VectorLeaf struct.
 */
export interface VectorLeaf {
    reference: Parser.SyntaxNode;
    text: string;
}

/**
 * Compare two Entry objects for equality.
 * Two entries are equal if they have the same kindId and text.
 * Mirrors the PartialEq implementation in Rust.
 */
export function entryEquals(a: Entry, b: Entry): boolean {
    return a.kindId === b.kindId && a.text === b.text;
}

/**
 * Configuration options for processing tree-sitter output.
 * Mirrors Rust TreeSitterProcessor struct from input_processing.rs
 */
export interface TreeSitterProcessorOptions {
    /**
     * Whether to split nodes into graphemes for more granular diffs.
     * If disabled, direct tree-sitter nodes will be used (faster, less granular).
     * @default true
     */
    splitGraphemes?: boolean;

    /**
     * Node types to exclude from processing. Takes precedence over includeKinds.
     * Set of strings corresponding to tree-sitter node types.
     */
    excludeKinds?: Set<string>;

    /**
     * Node types to explicitly include. Overridden by excludeKinds.
     * Set of strings corresponding to tree-sitter node types.
     */
    includeKinds?: Set<string>;

    /**
     * Whether to strip whitespace when processing node text.
     * Provides more accurate diffs that don't account for line breaks.
     * @default true
     */
    stripWhitespace?: boolean;

    /**
     * Mapping of language names to node types to treat as leaves.
     * Useful for grammars like markdown with "inline" node types.
     * Use "all" as the language key for global leaf types.
     */
    pseudoLeafTypes?: Map<string, Set<string>>;
}

/**
 * Processor for tree-sitter AST output.
 * Converts tree-sitter nodes into Entry objects for diffing.
 * Mirrors Rust TreeSitterProcessor from input_processing.rs
 */
export class TreeSitterProcessor {
    private splitGraphemes: boolean;
    private excludeKinds: Set<string> | null;
    private includeKinds: Set<string> | null;
    private stripWhitespace: boolean;
    private pseudoLeafTypes: Map<string, Set<string>>;

    constructor(options: TreeSitterProcessorOptions = {}) {
        this.splitGraphemes = options.splitGraphemes ?? false; // this is not useful for our usecase ?todo
        this.excludeKinds = options.excludeKinds ?? null;
        this.includeKinds = options.includeKinds ?? null;
        this.stripWhitespace = options.stripWhitespace ?? true;
        this.pseudoLeafTypes = options.pseudoLeafTypes ?? new Map([
            ['markdown', new Set(['inline'])]
        ]);
    }

    /**
     * Process a tree-sitter tree and return an array of Entry objects.
     * Mirrors Rust TreeSitterProcessor::process
     * 
     * @param tree - The parsed tree-sitter tree
     * @param text - The source text
     * @param langName - The language name (for pseudo-leaf type lookup)
     */
    process(tree: Parser.Tree, text: string, langName: string): Entry[] {
        const pseudoLeafTypes = this.pseudoLeafTypes.get(langName) ?? new Set<string>();  // todo can default to new Set, only used for markdown
        const leaves = this.buildLeaves(tree.rootNode, text, pseudoLeafTypes);

        // Filter leaves based on include/exclude settings
        const filteredLeaves = leaves.filter(leaf => this.shouldIncludeNode(leaf.reference));

        // Process leaves into entries
        if (this.splitGraphemes) {
            // Split on graphemes for more granular diffs
            return filteredLeaves.flatMap(leaf => this.splitOnGraphemes(leaf));
        } else {
            // Use direct leaf-to-entry conversion
            return filteredLeaves.map(leaf => this.processLeaf(leaf));
        }
    }

    /**
     * Build a flat array of VectorLeaf from the tree.
     * Performs in-order traversal collecting leaf nodes.
     * Mirrors Rust build() function.
     */
    private buildLeaves(
        node: Parser.SyntaxNode,
        text: string,
        pseudoLeafTypes: Set<string>
    ): VectorLeaf[] {
        const leaves: VectorLeaf[] = [];
        this.buildLeavesRecursive(leaves, node, text, pseudoLeafTypes);
        return leaves;
    }

    /**
     * Recursive helper for buildLeaves.
     * Mirrors Rust build() function.
     */
    private buildLeavesRecursive(
        leaves: VectorLeaf[],
        node: Parser.SyntaxNode,
        text: string,
        pseudoLeafTypes: Set<string>
    ): void {
        // If the node is a leaf or a pseudo-leaf type, add it
        if (node.childCount === 0 || pseudoLeafTypes.has(node.type)) {
            // Only push if the text range isn't empty
            const nodeText = node.text;
            if (nodeText.length > 0) {
                // Skip nodes that are only newlines (workaround for Go parser)
                const strippedText = nodeText.replace(/\r?\n/g, '');
                if (strippedText.length > 0) {
                    leaves.push({
                        reference: node,
                        text: nodeText,
                    });
                }
            }
            return;
        }

        // Recurse into children
        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child) {
                this.buildLeavesRecursive(leaves, child, text, pseudoLeafTypes);
            }
        }
    }

    /**
     * Process a VectorLeaf into an Entry.
     * Applies input processing according to options.
     * Mirrors Rust TreeSitterProcessor::process_leaf
     */
    private processLeaf(leaf: VectorLeaf): Entry {
        const newText = this.stripWhitespace ? leaf.text.trim() : leaf.text;

        return {
            kindId: leaf.reference.type,
            text: newText,
            startPosition: leaf.reference.startPosition,
            endPosition: leaf.reference.endPosition,
            reference: leaf.reference,
        };
    }

    /**
     * Split a leaf into multiple entries, one per grapheme.
     * Each grapheme gets its own Entry with resolved positions.
     * Mirrors Rust VectorLeaf::split_on_graphemes
     */
    private splitOnGraphemes(leaf: VectorLeaf): Entry[] {
        const entries: Entry[] = [];
        const lines = leaf.text.split('\n');

        for (let lineOffset = 0; lineOffset < lines.length; lineOffset++) {
            const line = lines[lineOffset];
            // Use spread operator to split into grapheme clusters
            // Note: JavaScript's string iterator yields code points, not grapheme clusters
            // For full Unicode grapheme support, consider using a library like 'graphemer'
            const graphemes = [...line];

            let columnOffset = 0;
            for (const grapheme of graphemes) {
                // Skip whitespace if configured
                if (this.stripWhitespace && /^\s+$/.test(grapheme)) {
                    columnOffset += grapheme.length;
                    continue;
                }

                // Calculate start column
                // On first line, offset from node's start position
                // On subsequent lines, start from 0
                const startColumn = lineOffset === 0
                    ? leaf.reference.startPosition.column + columnOffset
                    : columnOffset;

                const row = leaf.reference.startPosition.row + lineOffset;

                const entry: Entry = {
                    kindId: leaf.reference.type,
                    text: grapheme,
                    startPosition: { row, column: startColumn },
                    endPosition: { row, column: startColumn + grapheme.length },
                    reference: leaf.reference,
                };

                entries.push(entry);
                columnOffset += grapheme.length;
            }
        }

        return entries;
    }

    /**
     * Check if a node should be included based on filter settings.
     * Exclude takes precedence over include.
     * Mirrors Rust TreeSitterProcessor::should_include_node
     */
    private shouldIncludeNode(node: Parser.SyntaxNode): boolean {
        const kind = node.type;

        // Check exclusion first (takes precedence)
        if (this.excludeKinds?.has(kind)) {
            return false;
        }

        // Check inclusion list if specified
        if (this.includeKinds && !this.includeKinds.has(kind)) {
            return false;
        }

        return true;
    }
}

/**
 * Default processor instance with standard options
 */
export const defaultProcessor = new TreeSitterProcessor();

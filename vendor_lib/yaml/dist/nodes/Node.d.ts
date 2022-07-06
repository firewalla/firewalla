import type { Document } from '../doc/Document.js';
import { Token } from '../parse/cst.js';
import type { StringifyContext } from '../stringify/stringify.js';
import type { Alias } from './Alias.js';
import type { Pair } from './Pair.js';
import type { Scalar } from './Scalar.js';
import type { YAMLMap } from './YAMLMap.js';
import type { YAMLSeq } from './YAMLSeq.js';
export declare type Node = Alias | Scalar | YAMLMap | YAMLSeq;
export declare type ParsedNode = Alias.Parsed | Scalar.Parsed | YAMLMap.Parsed | YAMLSeq.Parsed;
export declare type Range = [number, number, number];
export declare const ALIAS: unique symbol;
export declare const DOC: unique symbol;
export declare const MAP: unique symbol;
export declare const PAIR: unique symbol;
export declare const SCALAR: unique symbol;
export declare const SEQ: unique symbol;
export declare const NODE_TYPE: unique symbol;
export declare const isAlias: (node: any) => node is Alias;
export declare const isDocument: (node: any) => node is Document<unknown>;
export declare const isMap: (node: any) => node is YAMLMap<unknown, unknown>;
export declare const isPair: (node: any) => node is Pair<unknown, unknown>;
export declare const isScalar: (node: any) => node is Scalar<unknown>;
export declare const isSeq: (node: any) => node is YAMLSeq<unknown>;
export declare function isCollection(node: any): node is YAMLMap | YAMLSeq;
export declare function isNode(node: any): node is Node;
export declare const hasAnchor: (node: unknown) => node is Scalar<unknown> | YAMLMap<unknown, unknown> | YAMLSeq<unknown>;
export declare abstract class NodeBase {
    readonly [NODE_TYPE]: symbol;
    /** A comment on or immediately after this */
    comment?: string | null;
    /** A comment before this */
    commentBefore?: string | null;
    /**
     * The `[start, value-end, node-end]` character offsets for the part of the
     * source parsed into this node (undefined if not parsed). The `value-end`
     * and `node-end` positions are themselves not included in their respective
     * ranges.
     */
    range?: Range | null;
    /** A blank line before this node and its commentBefore */
    spaceBefore?: boolean;
    /** The CST token that was composed into this node.  */
    srcToken?: Token;
    /** A fully qualified tag, if required */
    tag?: string;
    /** A plain JS representation of this node */
    abstract toJSON(): any;
    abstract toString(ctx?: StringifyContext, onComment?: () => void, onChompKeep?: () => void): string;
    constructor(type: symbol);
    /** Create a copy of this node.  */
    clone(): NodeBase;
}

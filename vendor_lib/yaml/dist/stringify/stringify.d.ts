import type { Document } from '../doc/Document.js';
import type { ToStringOptions } from '../options.js';
export declare type StringifyContext = {
    actualString?: boolean;
    allNullValues?: boolean;
    anchors: Set<string>;
    doc: Document;
    forceBlockIndent?: boolean;
    implicitKey?: boolean;
    indent: string;
    indentStep: string;
    indentAtStart?: number;
    inFlow?: boolean;
    inStringifyKey?: boolean;
    options: Readonly<Required<Omit<ToStringOptions, 'indent'>>>;
};
export declare const createStringifyContext: (doc: Document, options: ToStringOptions) => StringifyContext;
export declare function stringify(item: unknown, ctx: StringifyContext, onComment?: () => void, onChompKeep?: () => void): string;

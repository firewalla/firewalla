import { YAMLSeq } from '../../nodes/YAMLSeq.js';
import { ToJSContext } from '../../nodes/toJS.js';
import { CollectionTag } from '../types.js';
export declare class YAMLOMap extends YAMLSeq {
    static tag: string;
    constructor();
    add: (pair: import("../../index.js").Pair<any, any> | {
        key: any;
        value: any;
    }, overwrite?: boolean | undefined) => void;
    delete: (key: any) => boolean;
    get: (key: any, keepScalar?: boolean | undefined) => unknown;
    has: (key: any) => boolean;
    set: (key: any, value: any) => void;
    /**
     * If `ctx` is given, the return type is actually `Map<unknown, unknown>`,
     * but TypeScript won't allow widening the signature of a child method.
     */
    toJSON(_?: unknown, ctx?: ToJSContext): unknown[];
}
export declare const omap: CollectionTag;

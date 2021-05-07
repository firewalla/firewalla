"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (_) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __asyncValues = (this && this.__asyncValues) || function (o) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var m = o[Symbol.asyncIterator], i;
    return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i);
    function verb(n) { i[n] = o[n] && function (v) { return new Promise(function (resolve, reject) { v = o[n](v), settle(resolve, reject, v.done, v.value); }); }; }
    function settle(resolve, reject, d, v) { Promise.resolve(v).then(function(v) { resolve({ value: v, done: d }); }, reject); }
};
var __await = (this && this.__await) || function (v) { return this instanceof __await ? (this.v = v, this) : new __await(v); }
var __asyncGenerator = (this && this.__asyncGenerator) || function (thisArg, _arguments, generator) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var g = generator.apply(thisArg, _arguments || []), i, q = [];
    return i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i;
    function verb(n) { if (g[n]) i[n] = function (v) { return new Promise(function (a, b) { q.push([n, v, a, b]) > 1 || resume(n, v); }); }; }
    function resume(n, v) { try { step(g[n](v)); } catch (e) { settle(q[0][3], e); } }
    function step(r) { r.value instanceof __await ? Promise.resolve(r.value.v).then(fulfill, reject) : settle(q[0][2], r); }
    function fulfill(value) { resume("next", value); }
    function reject(value) { resume("throw", value); }
    function settle(f, v) { if (f(v), q.shift(), q.length) resume(q[0][0], q[0][1]); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.onExit = exports.streamEnd = exports.streamWrite = exports.chomp = exports.asyncIterableToArray = exports.chunksToLinesAsync = exports.readableToString = exports.StringStream = void 0;
var stream_1 = require("stream");
//---------- string -> stream
var StringStream = /** @class */ (function (_super) {
    __extends(StringStream, _super);
    function StringStream(str) {
        var _this = _super.call(this) || this;
        _this._str = str;
        _this._done = false;
        return _this;
    }
    StringStream.prototype._read = function () {
        if (!this._done) {
            this._done = true;
            this.push(this._str);
            this.push(null);
        }
    };
    return StringStream;
}(stream_1.Readable));
exports.StringStream = StringStream;
//---------- stream -> string
function readableToString(readable, encoding) {
    if (encoding === void 0) { encoding = 'utf8'; }
    return new Promise(function (resolve, reject) {
        readable.setEncoding(encoding);
        var data = '';
        readable.on('data', function (chunk) {
            data += chunk;
        });
        readable.on('end', function () {
            resolve(data);
        });
        readable.on('error', function (err) {
            reject(err);
        });
    });
}
exports.readableToString = readableToString;
//---------- async tools
/**
 * Parameter: async iterable of chunks (strings)
 * Result: async iterable of lines (incl. newlines)
 */
function chunksToLinesAsync(chunks) {
    return __asyncGenerator(this, arguments, function chunksToLinesAsync_1() {
        var previous, chunks_1, chunks_1_1, chunk, eolIndex, line, e_1_1;
        var e_1, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!Symbol.asyncIterator) {
                        throw new Error('Current JavaScript engine does not support asynchronous iterables');
                    }
                    if (!(Symbol.asyncIterator in chunks)) {
                        throw new Error('Parameter is not an asynchronous iterable');
                    }
                    previous = '';
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 9, 10, 15]);
                    chunks_1 = __asyncValues(chunks);
                    _b.label = 2;
                case 2: return [4 /*yield*/, __await(chunks_1.next())];
                case 3:
                    if (!(chunks_1_1 = _b.sent(), !chunks_1_1.done)) return [3 /*break*/, 8];
                    chunk = chunks_1_1.value;
                    previous += chunk;
                    eolIndex = void 0;
                    _b.label = 4;
                case 4:
                    if (!((eolIndex = previous.indexOf('\n')) >= 0)) return [3 /*break*/, 7];
                    line = previous.slice(0, eolIndex + 1);
                    return [4 /*yield*/, __await(line)];
                case 5: return [4 /*yield*/, _b.sent()];
                case 6:
                    _b.sent();
                    previous = previous.slice(eolIndex + 1);
                    return [3 /*break*/, 4];
                case 7: return [3 /*break*/, 2];
                case 8: return [3 /*break*/, 15];
                case 9:
                    e_1_1 = _b.sent();
                    e_1 = { error: e_1_1 };
                    return [3 /*break*/, 15];
                case 10:
                    _b.trys.push([10, , 13, 14]);
                    if (!(chunks_1_1 && !chunks_1_1.done && (_a = chunks_1.return))) return [3 /*break*/, 12];
                    return [4 /*yield*/, __await(_a.call(chunks_1))];
                case 11:
                    _b.sent();
                    _b.label = 12;
                case 12: return [3 /*break*/, 14];
                case 13:
                    if (e_1) throw e_1.error;
                    return [7 /*endfinally*/];
                case 14: return [7 /*endfinally*/];
                case 15:
                    if (!(previous.length > 0)) return [3 /*break*/, 18];
                    return [4 /*yield*/, __await(previous)];
                case 16: return [4 /*yield*/, _b.sent()];
                case 17:
                    _b.sent();
                    _b.label = 18;
                case 18: return [2 /*return*/];
            }
        });
    });
}
exports.chunksToLinesAsync = chunksToLinesAsync;
function asyncIterableToArray(asyncIterable) {
    var asyncIterable_1, asyncIterable_1_1;
    var e_2, _a;
    return __awaiter(this, void 0, Promise, function () {
        var result, elem, e_2_1;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    result = new Array();
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 6, 7, 12]);
                    asyncIterable_1 = __asyncValues(asyncIterable);
                    _b.label = 2;
                case 2: return [4 /*yield*/, asyncIterable_1.next()];
                case 3:
                    if (!(asyncIterable_1_1 = _b.sent(), !asyncIterable_1_1.done)) return [3 /*break*/, 5];
                    elem = asyncIterable_1_1.value;
                    result.push(elem);
                    _b.label = 4;
                case 4: return [3 /*break*/, 2];
                case 5: return [3 /*break*/, 12];
                case 6:
                    e_2_1 = _b.sent();
                    e_2 = { error: e_2_1 };
                    return [3 /*break*/, 12];
                case 7:
                    _b.trys.push([7, , 10, 11]);
                    if (!(asyncIterable_1_1 && !asyncIterable_1_1.done && (_a = asyncIterable_1.return))) return [3 /*break*/, 9];
                    return [4 /*yield*/, _a.call(asyncIterable_1)];
                case 8:
                    _b.sent();
                    _b.label = 9;
                case 9: return [3 /*break*/, 11];
                case 10:
                    if (e_2) throw e_2.error;
                    return [7 /*endfinally*/];
                case 11: return [7 /*endfinally*/];
                case 12: return [2 /*return*/, result];
            }
        });
    });
}
exports.asyncIterableToArray = asyncIterableToArray;
//---------- string tools
var RE_NEWLINE = /\r?\n$/u;
function chomp(line) {
    var match = RE_NEWLINE.exec(line);
    if (!match)
        return line;
    return line.slice(0, match.index);
}
exports.chomp = chomp;
//---------- Promisified writing to streams
/**
 * Usage:
 * <pre>
 * await streamWrite(someStream, 'abc');
 * await streamWrite(someStream, 'def');
 * await streamEnd(someStream);
 * </pre>
 *
 * @see https://nodejs.org/dist/latest-v10.x/docs/api/stream.html#stream_writable_write_chunk_encoding_callback
 */
function streamWrite(stream, chunk, encoding) {
    if (encoding === void 0) { encoding = 'utf8'; }
    // Get notified via callback when it’s “safe” to write again.
    // The alternatives are:
    // – 'drain' event waits until buffering is below “high water mark”
    // – callback waits until written content is unbuffered
    return streamPromiseHelper(stream, function (callback) { return stream.write(chunk, encoding, callback); });
}
exports.streamWrite = streamWrite;
function streamEnd(stream) {
    return streamPromiseHelper(stream, function (callback) { return stream.end(callback); });
}
exports.streamEnd = streamEnd;
function streamPromiseHelper(emitter, operation) {
    return new Promise(function (resolve, reject) {
        var errListener = function (err) {
            emitter.removeListener('error', errListener);
            reject(err);
        };
        emitter.addListener('error', errListener);
        var callback = function () {
            emitter.removeListener('error', errListener);
            resolve(undefined);
        };
        operation(callback);
    });
}
//---------- Tools for child processes
function onExit(childProcess) {
    return new Promise(function (resolve, reject) {
        childProcess.once('exit', function (code, signal) {
            if (code === 0) {
                resolve(undefined);
            }
            else {
                reject(new Error('Exit with error code: ' + code));
            }
        });
        childProcess.once('error', function (err) {
            reject(err);
        });
    });
}
exports.onExit = onExit;

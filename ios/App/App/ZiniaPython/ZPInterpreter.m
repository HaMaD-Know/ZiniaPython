//
//  ZPInterpreter.m
//  ZiniaPython
//
//  Embeds CPython following https://docs.python.org/3/using/ios.html :
//  UTF-8 mode on, unbuffered stdio, no bytecode writing, signal handlers on,
//  system logging on, PYTHONHOME = <bundle>/python, and a module search path
//  of python/lib/python3.X, python/lib/python3.X/lib-dynload and app.
//
//  Python.framework is weakly linked (see project.pbxproj) so that a missing
//  framework is reported as a diagnostic instead of a crash at launch.
//

#define PY_SSIZE_T_CLEAN
#include <Python.h>

#import "ZPInterpreter.h"

#include <dlfcn.h>
#include <os/log.h>
#include <os/proc.h>
#include <pthread.h>
#include <signal.h>

NSString *const ZPErrorDomain = @"ZiniaPythonRuntime";

static const NSUInteger ZPInterpreterStackSize = 8 * 1024 * 1024;  // Python recursion needs a large stack
static ZPInterpreter *gInterpreter = nil;
static os_log_t ZPLog(void) {
    static os_log_t log;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ log = os_log_create("com.ziniapython.ide", "runtime"); });
    return log;
}

#pragma mark - Input wait

@interface ZPInputWait : NSObject
@property (nonatomic, copy) NSString *executionId;
@property (nonatomic, strong) dispatch_semaphore_t semaphore;
@property (nonatomic, copy, nullable) NSString *text;
@property (nonatomic) BOOL endOfFile;
@property (nonatomic) BOOL cancelled;
@end

@implementation ZPInputWait
@end

#pragma mark - Helpers that require the GIL

/// Converts a Python str to NSString. Lone surrogates become U+FFFD-like '?'.
static NSString *_Nullable ZPStringFromPython(PyObject *_Nullable object) {
    if (object == NULL || !PyUnicode_Check(object)) {
        return nil;
    }
    PyObject *bytes = PyUnicode_AsEncodedString(object, "utf-8", "replace");
    if (bytes == NULL) {
        PyErr_Clear();
        return nil;
    }
    NSString *result = [[NSString alloc] initWithBytes:PyBytes_AS_STRING(bytes)
                                                length:(NSUInteger)PyBytes_GET_SIZE(bytes)
                                              encoding:NSUTF8StringEncoding];
    Py_DECREF(bytes);
    return result;
}

/// Formats and clears the current Python exception.
static NSString *ZPCurrentExceptionText(void) {
    PyObject *exception = PyErr_GetRaisedException();
    if (exception == NULL) {
        return @"(no Python exception was set)";
    }
    NSString *text = nil;
    PyObject *tracebackModule = PyImport_ImportModule("traceback");
    if (tracebackModule != NULL) {
        PyObject *lines = PyObject_CallMethod(tracebackModule, "format_exception", "O", exception);
        if (lines != NULL) {
            PyObject *empty = PyUnicode_FromString("");
            PyObject *joined = empty ? PyUnicode_Join(empty, lines) : NULL;
            text = ZPStringFromPython(joined);
            Py_XDECREF(joined);
            Py_XDECREF(empty);
            Py_DECREF(lines);
        }
        Py_DECREF(tracebackModule);
    }
    if (text == nil) {
        PyErr_Clear();
        PyObject *description = PyObject_Str(exception);
        text = ZPStringFromPython(description) ?: @"(unprintable Python exception)";
        Py_XDECREF(description);
    }
    PyErr_Clear();
    Py_DECREF(exception);
    return text;
}

/// Runs any pending signal handlers and discards the resulting exception.
/// Used so that a Stop that arrives between runs cannot leak into the next one.
static void ZPDiscardPendingSignals(void) {
    if (PyErr_CheckSignals() < 0) {
        PyErr_Clear();
    }
}

static NSString *ZPErrorResponse(NSString *code, NSString *message) {
    NSDictionary *payload = @{ @"ok": @NO, @"error": @{ @"code": code, @"message": message ?: @"" } };
    NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
    return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"{\"ok\":false}";
}

#pragma mark - _zinia_native module

static PyObject *ZPNative_emitOutput(PyObject *self, PyObject *args) {
    const char *executionId = NULL;
    int stream = 1;
    PyObject *text = NULL;
    if (!PyArg_ParseTuple(args, "siU:emit_output", &executionId, &stream, &text)) {
        return NULL;
    }
    @autoreleasepool {
        NSString *string = ZPStringFromPython(text);
        id<ZPInterpreterDelegate> delegate = gInterpreter.delegate;
        if (string.length > 0 && delegate != nil) {
            ZPOutputStream kind = (stream == 2) ? ZPOutputStreamStderr : (stream == 3 ? ZPOutputStreamSystem : ZPOutputStreamStdout);
            [delegate interpreterDidEmitOutput:string stream:kind executionId:@(executionId)];
        }
    }
    Py_RETURN_NONE;
}

static PyObject *ZPNative_emitEvent(PyObject *self, PyObject *args) {
    const char *name = NULL;
    PyObject *payload = NULL;
    if (!PyArg_ParseTuple(args, "sU:emit_event", &name, &payload)) {
        return NULL;
    }
    @autoreleasepool {
        NSString *json = ZPStringFromPython(payload);
        if (json != nil) {
            [gInterpreter.delegate interpreterDidEmitEvent:@(name) payloadJSON:json];
        }
    }
    Py_RETURN_NONE;
}

@interface ZPInterpreter ()
@property (atomic, readwrite) ZPInterpreterState state;
@property (atomic, readwrite, copy, nullable) NSString *activeExecutionId;
- (ZPInputWait *)beginInputWaitForExecution:(NSString *)executionId;
- (void)endInputWait:(ZPInputWait *)wait;
@property (nonatomic, readonly) dispatch_semaphore_t uiSemaphore;
- (NSArray<NSString *> *)takeUIEventsForExecution:(NSString *)executionId;
@end

static PyObject *ZPNative_readInput(PyObject *self, PyObject *args) {
    const char *executionId = NULL;
    if (!PyArg_ParseTuple(args, "s:read_input", &executionId)) {
        return NULL;
    }
    ZPInputWait *wait = nil;
    @autoreleasepool {
        NSString *identifier = @(executionId);
        wait = [gInterpreter beginInputWaitForExecution:identifier];
        [gInterpreter.delegate interpreterWillWaitForInputForExecution:identifier];
    }
    Py_BEGIN_ALLOW_THREADS
    dispatch_semaphore_wait(wait.semaphore, DISPATCH_TIME_FOREVER);
    Py_END_ALLOW_THREADS
    [gInterpreter endInputWait:wait];
    if (wait.cancelled) {
        PyErr_SetNone(PyExc_KeyboardInterrupt);
        return NULL;
    }
    if (wait.endOfFile || wait.text == nil) {
        Py_RETURN_NONE;
    }
    return PyUnicode_FromString(wait.text.UTF8String);
}

/// wait_ui(execution_id, timeout) -> list[str]
/// Returns the UI event batches (JSON strings) the graphics preview posted for
/// this execution, waiting up to `timeout` seconds (GIL released) when none
/// are queued. Used by zinia_draw / zinia_3d animation loops.
static PyObject *ZPNative_waitUI(PyObject *self, PyObject *args) {
    const char *executionId = NULL;
    double timeout = 0;
    if (!PyArg_ParseTuple(args, "sd:wait_ui", &executionId, &timeout)) {
        return NULL;
    }
    if (timeout < 0) timeout = 0;
    if (timeout > 5) timeout = 5;
    NSArray<NSString *> *events = nil;
    @autoreleasepool {
        NSString *identifier = @(executionId);
        events = [gInterpreter takeUIEventsForExecution:identifier];
        if (events.count == 0 && timeout > 0) {
            dispatch_semaphore_t semaphore = gInterpreter.uiSemaphore;
            Py_BEGIN_ALLOW_THREADS
            dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(timeout * NSEC_PER_SEC)));
            Py_END_ALLOW_THREADS
            events = [gInterpreter takeUIEventsForExecution:identifier];
        }
    }
    PyObject *list = PyList_New(0);
    if (list == NULL) {
        return NULL;
    }
    for (NSString *batch in events) {
        PyObject *item = PyUnicode_FromString(batch.UTF8String);
        if (item == NULL || PyList_Append(list, item) < 0) {
            Py_XDECREF(item);
            Py_DECREF(list);
            return NULL;
        }
        Py_DECREF(item);
    }
    return list;
}

static PyObject *ZPNative_httpGet(PyObject *self, PyObject *args) {
    const char *urlString = NULL;
    double timeout = 60.0;
    long long maxBytes = 0;
    if (!PyArg_ParseTuple(args, "sdL:http_get", &urlString, &timeout, &maxBytes)) {
        return NULL;
    }
    NSURL *url = [NSURL URLWithString:@(urlString)];
    if (url == nil || ![url.scheme.lowercaseString isEqualToString:@"https"]) {
        PyErr_SetString(PyExc_ValueError, "only https:// URLs are allowed");
        return NULL;
    }
    __block NSData *body = nil;
    __block NSInteger status = 0;
    __block NSError *failure = nil;
    Py_BEGIN_ALLOW_THREADS
    @autoreleasepool {
        NSURLSessionConfiguration *configuration = [NSURLSessionConfiguration ephemeralSessionConfiguration];
        configuration.timeoutIntervalForRequest = timeout > 0 ? timeout : 60.0;
        configuration.timeoutIntervalForResource = 600.0;
        NSURLSession *session = [NSURLSession sessionWithConfiguration:configuration];
        NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
        [request setValue:@"ZiniaPython-IDE (+https://github.com)" forHTTPHeaderField:@"User-Agent"];
        dispatch_semaphore_t done = dispatch_semaphore_create(0);
        NSURLSessionDataTask *task = [session dataTaskWithRequest:request
                                                completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
            body = data;
            failure = error;
            if ([response isKindOfClass:[NSHTTPURLResponse class]]) {
                status = ((NSHTTPURLResponse *)response).statusCode;
            }
            dispatch_semaphore_signal(done);
        }];
        [task resume];
        dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
        [session finishTasksAndInvalidate];
    }
    Py_END_ALLOW_THREADS
    if (failure != nil) {
        PyErr_SetString(PyExc_OSError, failure.localizedDescription.UTF8String ?: "network error");
        return NULL;
    }
    if (maxBytes > 0 && (long long)body.length > maxBytes) {
        PyErr_SetString(PyExc_OSError, "response is larger than the allowed maximum");
        return NULL;
    }
    return Py_BuildValue("(iy#)", (int)status, body.bytes ?: "", (Py_ssize_t)body.length);
}

static PyMethodDef ZPNativeMethods[] = {
    {"emit_output", ZPNative_emitOutput, METH_VARARGS, "emit_output(execution_id, stream, text)"},
    {"emit_event", ZPNative_emitEvent, METH_VARARGS, "emit_event(name, payload_json)"},
    {"read_input", ZPNative_readInput, METH_VARARGS, "read_input(execution_id) -> str | None"},
    {"wait_ui", ZPNative_waitUI, METH_VARARGS, "wait_ui(execution_id, timeout) -> list[str]"},
    {"http_get", ZPNative_httpGet, METH_VARARGS, "http_get(url, timeout, max_bytes) -> (status, bytes)"},
    {NULL, NULL, 0, NULL},
};

static struct PyModuleDef ZPNativeModule = {
    PyModuleDef_HEAD_INIT,
    "_zinia_native",
    "Bridge between ZiniaPython's runtime package and the iOS host.",
    -1,
    ZPNativeMethods,
};

static PyObject *PyInit__zinia_native(void) {
    return PyModule_Create(&ZPNativeModule);
}

#pragma mark - Status helpers

static NSError *ZPError(ZPErrorCode code, NSString *message, NSDictionary *_Nullable extra) {
    NSMutableDictionary *info = [NSMutableDictionary dictionaryWithObject:message forKey:NSLocalizedDescriptionKey];
    if (extra != nil) {
        [info addEntriesFromDictionary:extra];
    }
    return [NSError errorWithDomain:ZPErrorDomain code:code userInfo:info];
}

static NSError *ZPStatusError(ZPErrorCode code, NSString *stage, PyStatus status) {
    NSString *function = status.func ? @(status.func) : @"?";
    NSString *message = status.err_msg ? @(status.err_msg) : @"unknown error";
    return ZPError(code, [NSString stringWithFormat:@"%@ failed in %@: %@", stage, function, message], nil);
}

static PyStatus ZPAppendSearchPath(PyConfig *config, NSString *path) {
    wchar_t *wide = Py_DecodeLocale(path.fileSystemRepresentation, NULL);
    if (wide == NULL) {
        return PyStatus_Error("could not decode a module search path");
    }
    PyStatus status = PyWideStringList_Append(&config->module_search_paths, wide);
    PyMem_RawFree(wide);
    return status;
}

#pragma mark - ZPInterpreter

@implementation ZPInterpreter {
    NSThread *_thread;
    NSCondition *_queueCondition;
    NSMutableArray<dispatch_block_t> *_queue;
    pthread_t _pythonThread;
    BOOL _pythonThreadKnown;
    BOOL _pythonTouched;
    PyThreadState *_savedThreadState;
    PyObject *_handleFunction;
    NSLock *_inputLock;
    NSLock *_uiLock;
    NSMutableArray<NSString *> *_uiEvents;
    NSString *_uiExecution;
    ZPInputWait *_inputWait;
    NSMutableArray *_startCompletions;
    NSString *_runtimeInfo;
    NSError *_startError;
}

@synthesize state = _state;
@synthesize activeExecutionId = _activeExecutionId;

+ (ZPInterpreter *)shared {
    static ZPInterpreter *instance;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        instance = [[ZPInterpreter alloc] init];
        gInterpreter = instance;
    });
    return instance;
}

- (instancetype)init {
    if ((self = [super init])) {
        _queueCondition = [[NSCondition alloc] init];
        _queue = [NSMutableArray array];
        _inputLock = [[NSLock alloc] init];
        _uiLock = [[NSLock alloc] init];
        _uiEvents = [NSMutableArray array];
        _uiSemaphore = dispatch_semaphore_create(0);
        _startCompletions = [NSMutableArray array];
        _state = ZPInterpreterStateNotStarted;
    }
    return self;
}

+ (NSString *)compiledPythonVersion {
    return @PY_VERSION;
}

+ (NSString *)stdlibFolderName {
    return [NSString stringWithFormat:@"python%d.%d", PY_MAJOR_VERSION, PY_MINOR_VERSION];
}

+ (uint64_t)availableMemory {
    return (uint64_t)os_proc_available_memory();
}

+ (BOOL)pythonSymbolsAvailable {
    return dlsym(RTLD_DEFAULT, "Py_InitializeFromConfig") != NULL;
}

+ (NSError *)validateBundleLayoutAtResourcePath:(NSString *)resourcePath {
    NSFileManager *fm = NSFileManager.defaultManager;
    NSString *stdlib = [resourcePath stringByAppendingFormat:@"/python/lib/%@", self.stdlibFolderName];
    NSArray<NSString *> *required = @[
        [stdlib stringByAppendingPathComponent:@"os.py"],
        [stdlib stringByAppendingPathComponent:@"encodings/__init__.py"],
        [stdlib stringByAppendingPathComponent:@"lib-dynload"],
    ];
    NSMutableArray<NSString *> *missing = [NSMutableArray array];
    for (NSString *path in required) {
        if (![fm fileExistsAtPath:path]) {
            [missing addObject:path];
        }
    }
    if (missing.count > 0) {
        return ZPError(ZPErrorCodeStdlibMissing,
                       [NSString stringWithFormat:@"The Python standard library (%@) is missing from the app bundle. "
                        "The 'Process Python libraries' build phase did not run or failed.", self.stdlibFolderName],
                       @{ @"missingPaths": missing, @"resourcePath": resourcePath });
    }
    NSString *bridge = [resourcePath stringByAppendingPathComponent:@"python-app/zinia/bridge.py"];
    if (![fm fileExistsAtPath:bridge]) {
        return ZPError(ZPErrorCodeSupportMissing,
                       @"ZiniaPython's runtime package (python-app/zinia) is missing from the app bundle. "
                       "The 'Install ZiniaPython runtime package' build phase did not run.",
                       @{ @"missingPaths": @[bridge], @"resourcePath": resourcePath });
    }
    return nil;
}

#pragma mark Thread and queue

- (void)ensureThread {
    @synchronized (self) {
        if (_thread != nil) {
            return;
        }
        _thread = [[NSThread alloc] initWithTarget:self selector:@selector(threadMain) object:nil];
        _thread.name = @"ZiniaPython interpreter";
        _thread.stackSize = ZPInterpreterStackSize;
        _thread.qualityOfService = NSQualityOfServiceUserInitiated;
        [_thread start];
    }
}

- (void)threadMain {
    _pythonThread = pthread_self();
    _pythonThreadKnown = YES;
    while (YES) {
        dispatch_block_t job = nil;
        [_queueCondition lock];
        while (_queue.count == 0) {
            [_queueCondition wait];
        }
        job = _queue.firstObject;
        [_queue removeObjectAtIndex:0];
        [_queueCondition unlock];
        @autoreleasepool {
            job();
        }
    }
}

- (void)enqueue:(dispatch_block_t)job {
    [self ensureThread];
    [_queueCondition lock];
    [_queue addObject:[job copy]];
    [_queueCondition signal];
    [_queueCondition unlock];
}

#pragma mark Start-up

- (void)startWithResourcePath:(NSString *)resourcePath
                configuration:(NSDictionary<NSString *, id> *)configuration
                   completion:(void (^)(NSString *, NSError *))completion {
    @synchronized (self) {
        switch (_state) {
            case ZPInterpreterStateReady: {
                NSString *info = _runtimeInfo;
                dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{ completion(info, nil); });
                return;
            }
            case ZPInterpreterStateFailed: {
                NSError *error = ZPError(ZPErrorCodeAlreadyFailed,
                                         [NSString stringWithFormat:@"Python failed to start earlier in this session and "
                                          "cannot be restarted without relaunching the app. Original error: %@",
                                          _startError.localizedDescription ?: @"unknown"],
                                         _startError.userInfo);
                dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{ completion(nil, error); });
                return;
            }
            case ZPInterpreterStateStarting:
                [_startCompletions addObject:[completion copy]];
                return;
            case ZPInterpreterStateNotStarted:
                [_startCompletions addObject:[completion copy]];
                _state = ZPInterpreterStateStarting;
                break;
        }
    }
    NSDictionary *config = [configuration copy];
    NSString *path = [resourcePath copy];
    [self enqueue:^{
        [self bootWithResourcePath:path configuration:config];
    }];
}

- (void)finishStartWithInfo:(NSString *)info error:(NSError *)error {
    NSArray *completions;
    @synchronized (self) {
        if (error == nil) {
            _state = ZPInterpreterStateReady;
            _runtimeInfo = info;
        } else if (_pythonTouched) {
            _state = ZPInterpreterStateFailed;   // CPython cannot be safely re-initialised
            _startError = error;
        } else {
            _state = ZPInterpreterStateNotStarted; // nothing was touched; a retry is safe
        }
        completions = [_startCompletions copy];
        [_startCompletions removeAllObjects];
    }
    if (error != nil) {
        os_log_error(ZPLog(), "Python start failed: %{public}@", error.localizedDescription);
    }
    for (void (^completion)(NSString *, NSError *) in completions) {
        completion(info, error);
    }
}

- (void)bootWithResourcePath:(NSString *)resourcePath configuration:(NSDictionary *)configuration {
    if (![ZPInterpreter pythonSymbolsAvailable]) {
        [self finishStartWithInfo:nil error:ZPError(ZPErrorCodeFrameworkMissing,
            @"Python.framework is not loaded. The framework was not embedded in the app bundle.", nil)];
        return;
    }
    NSError *layoutError = [ZPInterpreter validateBundleLayoutAtResourcePath:resourcePath];
    if (layoutError != nil) {
        [self finishStartWithInfo:nil error:layoutError];
        return;
    }

    NSString *home = [resourcePath stringByAppendingPathComponent:@"python"];
    NSString *stdlib = [home stringByAppendingFormat:@"/lib/%@", ZPInterpreter.stdlibFolderName];
    NSArray<NSString *> *searchPaths = @[
        stdlib,
        [stdlib stringByAppendingPathComponent:@"lib-dynload"],
        [resourcePath stringByAppendingPathComponent:@"python-app"],
    ];

    _pythonTouched = YES;
    PyStatus status;
    PyPreConfig preconfig;
    PyPreConfig_InitIsolatedConfig(&preconfig);
    preconfig.utf8_mode = 1;
    status = Py_PreInitialize(&preconfig);
    if (PyStatus_Exception(status)) {
        [self finishStartWithInfo:nil error:ZPStatusError(ZPErrorCodePreInitFailed, @"Py_PreInitialize", status)];
        return;
    }

    if (PyImport_AppendInittab("_zinia_native", PyInit__zinia_native) != 0) {
        [self finishStartWithInfo:nil error:ZPError(ZPErrorCodeInitFailed, @"Could not register the _zinia_native module.", nil)];
        return;
    }

    PyConfig config;
    PyConfig_InitIsolatedConfig(&config);
    config.buffered_stdio = 0;
    config.write_bytecode = 0;
    config.install_signal_handlers = 1;
    config.site_import = 1;
    config.parse_argv = 0;
    config.module_search_paths_set = 1;
#if defined(__APPLE__) && PY_VERSION_HEX >= 0x030E0000
    config.use_system_logger = 1;
#endif

    status = PyConfig_SetBytesString(&config, &config.home, home.fileSystemRepresentation);
    if (!PyStatus_Exception(status)) {
        NSString *program = NSBundle.mainBundle.executablePath ?: @"ZiniaPython";
        status = PyConfig_SetBytesString(&config, &config.program_name, program.fileSystemRepresentation);
    }
    for (NSString *path in searchPaths) {
        if (PyStatus_Exception(status)) {
            break;
        }
        status = ZPAppendSearchPath(&config, path);
    }
    if (PyStatus_Exception(status)) {
        PyConfig_Clear(&config);
        [self finishStartWithInfo:nil error:ZPStatusError(ZPErrorCodeInitFailed, @"Configuring Python", status)];
        return;
    }

    status = Py_InitializeFromConfig(&config);
    PyConfig_Clear(&config);
    if (PyStatus_Exception(status)) {
        [self finishStartWithInfo:nil error:ZPStatusError(ZPErrorCodeInitFailed, @"Py_InitializeFromConfig", status)];
        return;
    }

    // This thread now holds the GIL.
    NSError *error = nil;
    NSString *info = nil;
    PyObject *module = PyImport_ImportModule("zinia.bridge");
    if (module == NULL) {
        error = ZPError(ZPErrorCodeBridgeImportFailed, @"Importing ZiniaPython's runtime package failed.",
                        @{ @"pythonTraceback": ZPCurrentExceptionText() });
    } else {
        PyObject *initialize = PyObject_GetAttrString(module, "initialize");
        _handleFunction = PyObject_GetAttrString(module, "handle");
        Py_DECREF(module);
        if (initialize == NULL || _handleFunction == NULL) {
            error = ZPError(ZPErrorCodeBridgeImportFailed, @"zinia.bridge is incomplete.",
                            @{ @"pythonTraceback": ZPCurrentExceptionText() });
        } else {
            NSData *data = [NSJSONSerialization dataWithJSONObject:configuration options:0 error:nil];
            NSString *configJSON = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"{}";
            PyObject *argument = PyUnicode_FromString(configJSON.UTF8String);
            PyObject *reply = argument ? PyObject_CallOneArg(initialize, argument) : NULL;
            Py_XDECREF(argument);
            if (reply == NULL) {
                error = ZPError(ZPErrorCodeBridgeInitFailed, @"zinia.bridge.initialize() raised an exception.",
                                @{ @"pythonTraceback": ZPCurrentExceptionText() });
            } else {
                info = ZPStringFromPython(reply);
                Py_DECREF(reply);
                NSDictionary *parsed = info ? [NSJSONSerialization JSONObjectWithData:[info dataUsingEncoding:NSUTF8StringEncoding]
                                                                              options:0 error:nil] : nil;
                if (![parsed isKindOfClass:[NSDictionary class]] || ![parsed[@"ok"] boolValue]) {
                    NSDictionary *details = [parsed isKindOfClass:[NSDictionary class]] ? parsed[@"error"] : nil;
                    error = ZPError(ZPErrorCodeBridgeInitFailed,
                                    [NSString stringWithFormat:@"zinia.bridge.initialize() failed: %@",
                                     details[@"message"] ?: @"unknown error"],
                                    @{ @"pythonTraceback": details[@"traceback"] ?: @"" });
                    info = nil;
                }
            }
            Py_DECREF(initialize);
        }
    }
    ZPDiscardPendingSignals();
    _savedThreadState = PyEval_SaveThread();
    [self finishStartWithInfo:info error:error];
}

#pragma mark Requests

- (void)submitRequestJSON:(NSString *)requestJSON
              executionId:(NSString *)executionId
               completion:(void (^)(NSString *))completion {
    if (self.state != ZPInterpreterStateReady) {
        completion(ZPErrorResponse(@"NOT_READY", @"The Python runtime is not running."));
        return;
    }
    NSString *json = [requestJSON copy];
    NSString *identifier = [executionId copy];
    [self enqueue:^{
        PyEval_RestoreThread(self->_savedThreadState);
        ZPDiscardPendingSignals();
        [self->_uiLock lock];
        [self->_uiEvents removeAllObjects];  // nothing from an earlier run reaches this one
        self->_uiExecution = identifier;
        [self->_uiLock unlock];
        self.activeExecutionId = identifier;
        NSString *response = nil;
        PyObject *argument = PyUnicode_FromString(json.UTF8String);
        PyObject *reply = argument ? PyObject_CallOneArg(self->_handleFunction, argument) : NULL;
        Py_XDECREF(argument);
        if (reply != NULL) {
            response = ZPStringFromPython(reply);
            Py_DECREF(reply);
        }
        if (response == nil) {
            response = ZPErrorResponse(@"INTERNAL", ZPCurrentExceptionText());
        }
        self.activeExecutionId = nil;
        ZPDiscardPendingSignals();  // a Stop that raced with the end of the run
        self->_savedThreadState = PyEval_SaveThread();
        completion(response);
    }];
}

- (NSString *)interruptExecution:(NSString *)executionId {
    NSString *active = self.activeExecutionId;
    if (active == nil || ![active isEqualToString:executionId]) {
        return nil;
    }
    // A script blocked in input(): wake it up; read_input raises KeyboardInterrupt.
    [_inputLock lock];
    ZPInputWait *wait = _inputWait;
    if (wait != nil && [wait.executionId isEqualToString:executionId]) {
        wait.cancelled = YES;
        _inputWait = nil;
        dispatch_semaphore_signal(wait.semaphore);
        [_inputLock unlock];
        return @"input-cancelled";
    }
    [_inputLock unlock];

    // Equivalent to pressing Ctrl+C: KeyboardInterrupt at the next bytecode boundary.
    PyErr_SetInterruptEx(SIGINT);
    dispatch_semaphore_signal(_uiSemaphore);  // wake an animation loop waiting for UI events
    NSString *how = @"keyboard-interrupt";
    // Also deliver a real SIGINT to the interpreter thread so blocking calls such
    // as time.sleep() return early - but only while Python's own handler (or a
    // script's handler) is installed. With the default disposition SIGINT would
    // terminate the app, so it is never sent in that case.
    struct sigaction current;
    if (_pythonThreadKnown && sigaction(SIGINT, NULL, &current) == 0
        && current.sa_handler != SIG_DFL && current.sa_handler != SIG_IGN) {
        if (pthread_kill(_pythonThread, SIGINT) == 0) {
            how = @"keyboard-interrupt+signal";
        }
    }
    return how;
}

#pragma mark Input

- (ZPInputWait *)beginInputWaitForExecution:(NSString *)executionId {
    ZPInputWait *wait = [[ZPInputWait alloc] init];
    wait.executionId = executionId;
    wait.semaphore = dispatch_semaphore_create(0);
    [_inputLock lock];
    _inputWait = wait;
    [_inputLock unlock];
    return wait;
}

- (void)endInputWait:(ZPInputWait *)wait {
    [_inputLock lock];
    if (_inputWait == wait) {
        _inputWait = nil;
    }
    [_inputLock unlock];
}

- (BOOL)provideInput:(NSString *)text forExecution:(NSString *)executionId {
    [_inputLock lock];
    ZPInputWait *wait = _inputWait;
    if (wait == nil || ![wait.executionId isEqualToString:executionId]) {
        [_inputLock unlock];
        return NO;
    }
    wait.text = text;
    wait.endOfFile = (text == nil);
    _inputWait = nil;
    dispatch_semaphore_signal(wait.semaphore);
    [_inputLock unlock];
    return YES;
}

#pragma mark UI events (graphics preview -> Python)

- (BOOL)postUIEvents:(NSString *)eventsJSON forExecution:(NSString *)executionId {
    NSString *active = self.activeExecutionId;
    if (active == nil || ![active isEqualToString:executionId]) {
        return NO;
    }
    [_uiLock lock];
    if (![_uiExecution isEqualToString:executionId]) {
        [_uiEvents removeAllObjects];
        _uiExecution = [executionId copy];
    }
    if (_uiEvents.count >= 600) {
        [_uiEvents removeObjectAtIndex:0];  // a stalled script must not grow this without bound
    }
    [_uiEvents addObject:[eventsJSON copy]];
    [_uiLock unlock];
    dispatch_semaphore_signal(_uiSemaphore);
    return YES;
}

- (NSArray<NSString *> *)takeUIEventsForExecution:(NSString *)executionId {
    // Drop stale wake-ups first: every event queued so far is taken below, and
    // anything posted after this point signals again, so it is never missed.
    while (dispatch_semaphore_wait(_uiSemaphore, DISPATCH_TIME_NOW) == 0) {
    }
    [_uiLock lock];
    NSArray<NSString *> *events = @[];
    if ([_uiExecution isEqualToString:executionId] && _uiEvents.count > 0) {
        events = [_uiEvents copy];
        [_uiEvents removeAllObjects];
    }
    [_uiLock unlock];
    return events;
}

- (BOOL)isWaitingForInput {
    [_inputLock lock];
    BOOL waiting = _inputWait != nil;
    [_inputLock unlock];
    return waiting;
}

@end

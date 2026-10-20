/**
 * Static data for local autocompletion. No code ever leaves the device:
 * suggestions come from these lists, the open document, and the module names
 * of files in the current project.
 */

export const PYTHON_KEYWORDS = [
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'case', 'class', 'continue',
  'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
  'lambda', 'match', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'type', 'while', 'with', 'yield',
];

export const PYTHON_BUILTINS: Record<string, string> = {
  abs: 'abs(x)', aiter: 'aiter(async_iterable)', all: 'all(iterable)', anext: 'anext(async_iterator)',
  any: 'any(iterable)', ascii: 'ascii(object)', bin: 'bin(x)', bool: 'bool(x=False)', breakpoint: 'breakpoint()',
  bytearray: 'bytearray(source=b"")', bytes: 'bytes(source=b"")', callable: 'callable(object)', chr: 'chr(i)',
  classmethod: '@classmethod', compile: 'compile(source, filename, mode)', complex: 'complex(real=0, imag=0)',
  delattr: 'delattr(object, name)', dict: 'dict(**kwargs)', dir: 'dir([object])', divmod: 'divmod(a, b)',
  enumerate: 'enumerate(iterable, start=0)', eval: 'eval(expression)', exec: 'exec(source)',
  filter: 'filter(function, iterable)', float: 'float(x=0.0)', format: 'format(value, format_spec="")',
  frozenset: 'frozenset(iterable=())', getattr: 'getattr(object, name[, default])', globals: 'globals()',
  hasattr: 'hasattr(object, name)', hash: 'hash(object)', help: 'help([object])', hex: 'hex(x)', id: 'id(object)',
  input: 'input(prompt="")', int: 'int(x=0, base=10)', isinstance: 'isinstance(object, classinfo)',
  issubclass: 'issubclass(class, classinfo)', iter: 'iter(object)', len: 'len(s)', list: 'list(iterable=())',
  locals: 'locals()', map: 'map(function, iterable, ...)', max: 'max(iterable, *, key=None)',
  memoryview: 'memoryview(object)', min: 'min(iterable, *, key=None)', next: 'next(iterator[, default])',
  object: 'object()', oct: 'oct(x)', open: 'open(file, mode="r", encoding=None)', ord: 'ord(c)',
  pow: 'pow(base, exp, mod=None)', print: 'print(*objects, sep=" ", end="\\n", file=None)',
  property: 'property(fget=None, fset=None)', range: 'range(start, stop[, step])', repr: 'repr(object)',
  reversed: 'reversed(seq)', round: 'round(number, ndigits=None)', set: 'set(iterable=())',
  setattr: 'setattr(object, name, value)', slice: 'slice(start, stop[, step])',
  sorted: 'sorted(iterable, *, key=None, reverse=False)', staticmethod: '@staticmethod', str: 'str(object="")',
  sum: 'sum(iterable, start=0)', super: 'super()', tuple: 'tuple(iterable=())', type: 'type(object)',
  vars: 'vars([object])', zip: 'zip(*iterables, strict=False)', __import__: '__import__(name)',
};

export const BUILTIN_EXCEPTIONS = [
  'BaseException', 'Exception', 'ArithmeticError', 'AssertionError', 'AttributeError', 'EOFError',
  'FileExistsError', 'FileNotFoundError', 'ImportError', 'IndexError', 'KeyError', 'KeyboardInterrupt',
  'LookupError', 'MemoryError', 'ModuleNotFoundError', 'NameError', 'NotImplementedError', 'OSError',
  'OverflowError', 'PermissionError', 'RecursionError', 'RuntimeError', 'StopIteration', 'SyntaxError',
  'SystemExit', 'TimeoutError', 'TypeError', 'UnicodeDecodeError', 'UnicodeEncodeError', 'ValueError',
  'ZeroDivisionError', 'ExceptionGroup', 'NotImplemented', 'Ellipsis',
];

/** Commonly used standard-library modules (availability is checked at run time, not assumed). */
export const STDLIB_MODULES = [
  'abc', 'argparse', 'array', 'ast', 'asyncio', 'base64', 'binascii', 'bisect', 'builtins', 'bz2', 'calendar',
  'cmath', 'codecs', 'collections', 'collections.abc', 'colorsys', 'compression', 'concurrent.futures',
  'configparser', 'contextlib', 'contextvars', 'copy', 'csv', 'ctypes', 'dataclasses', 'datetime', 'dbm',
  'decimal', 'difflib', 'dis', 'doctest', 'email', 'enum', 'errno', 'filecmp', 'fnmatch', 'fractions',
  'functools', 'gc', 'getpass', 'gettext', 'glob', 'graphlib', 'gzip', 'hashlib', 'heapq', 'hmac', 'html',
  'html.parser', 'http', 'http.client', 'importlib', 'inspect', 'io', 'ipaddress', 'itertools', 'json',
  'keyword', 'linecache', 'locale', 'logging', 'lzma', 'math', 'mimetypes', 'numbers', 'operator', 'os',
  'os.path', 'pathlib', 'pickle', 'platform', 'pprint', 'queue', 'random', 're', 'reprlib', 'sched',
  'secrets', 'select', 'shelve', 'shlex', 'shutil', 'signal', 'socket', 'sqlite3', 'ssl', 'statistics',
  'string', 'struct', 'sys', 'sysconfig', 'tempfile', 'textwrap', 'threading', 'time', 'timeit', 'tokenize',
  'tomllib', 'traceback', 'types', 'typing', 'unicodedata', 'unittest', 'urllib', 'urllib.parse',
  'urllib.request', 'uuid', 'warnings', 'weakref', 'xml', 'xml.etree.ElementTree', 'zipfile', 'zlib', 'zoneinfo',
];

/** Members of a few very common modules, offered after "module.". */
export const MODULE_MEMBERS: Record<string, string[]> = {
  math: ['pi', 'e', 'tau', 'inf', 'nan', 'sqrt', 'pow', 'exp', 'log', 'log2', 'log10', 'sin', 'cos', 'tan',
    'asin', 'acos', 'atan', 'atan2', 'floor', 'ceil', 'trunc', 'fabs', 'factorial', 'gcd', 'lcm', 'comb', 'perm',
    'isclose', 'isqrt', 'hypot', 'degrees', 'radians', 'prod', 'fsum', 'dist'],
  random: ['random', 'randint', 'randrange', 'choice', 'choices', 'shuffle', 'sample', 'uniform', 'gauss', 'seed'],
  os: ['getcwd', 'chdir', 'listdir', 'scandir', 'mkdir', 'makedirs', 'remove', 'rename', 'replace', 'rmdir',
    'walk', 'environ', 'getenv', 'path', 'sep', 'linesep', 'cpu_count', 'urandom'],
  'os.path': ['join', 'exists', 'isfile', 'isdir', 'basename', 'dirname', 'splitext', 'abspath', 'getsize', 'expanduser'],
  sys: ['argv', 'path', 'modules', 'version', 'version_info', 'platform', 'exit', 'stdin', 'stdout', 'stderr',
    'getrecursionlimit', 'setrecursionlimit', 'executable', 'maxsize'],
  json: ['dumps', 'loads', 'dump', 'load', 'JSONDecodeError'],
  re: ['compile', 'search', 'match', 'fullmatch', 'findall', 'finditer', 'sub', 'subn', 'split', 'escape', 'IGNORECASE', 'MULTILINE', 'DOTALL'],
  time: ['time', 'sleep', 'perf_counter', 'monotonic', 'strftime', 'localtime', 'gmtime'],
  datetime: ['datetime', 'date', 'time', 'timedelta', 'timezone'],
  pathlib: ['Path', 'PurePath'],
  collections: ['Counter', 'defaultdict', 'deque', 'namedtuple', 'OrderedDict', 'ChainMap'],
  itertools: ['count', 'cycle', 'repeat', 'accumulate', 'chain', 'combinations', 'permutations', 'product',
    'groupby', 'islice', 'pairwise', 'batched', 'zip_longest', 'starmap', 'takewhile', 'dropwhile'],
  functools: ['reduce', 'partial', 'lru_cache', 'cache', 'wraps', 'cached_property', 'total_ordering', 'singledispatch'],
  statistics: ['mean', 'median', 'mode', 'stdev', 'variance', 'pstdev', 'quantiles', 'fmean', 'geometric_mean'],
  typing: ['Any', 'Optional', 'Union', 'Callable', 'Iterable', 'Iterator', 'Sequence', 'Mapping', 'TypeVar', 'Generic', 'Protocol', 'Literal', 'TypedDict'],
  string: ['ascii_letters', 'ascii_lowercase', 'ascii_uppercase', 'digits', 'punctuation', 'whitespace', 'Template'],
  unittest: ['TestCase', 'main', 'mock', 'skip', 'skipIf', 'expectedFailure'],
  asyncio: ['run', 'sleep', 'gather', 'create_task', 'Queue', 'Event', 'Lock', 'wait_for', 'TaskGroup', 'timeout'],
};

export const SNIPPETS: { label: string; detail: string; template: string }[] = [
  { label: 'def', detail: 'function', template: 'def ${name}(${params}):\n\t${pass}' },
  { label: 'class', detail: 'class', template: 'class ${Name}:\n\tdef __init__(self${, args}):\n\t\t${pass}' },
  { label: 'ifmain', detail: 'if __name__ == "__main__"', template: 'if __name__ == "__main__":\n\t${main()}' },
  { label: 'for', detail: 'for loop', template: 'for ${item} in ${iterable}:\n\t${pass}' },
  { label: 'while', detail: 'while loop', template: 'while ${condition}:\n\t${pass}' },
  { label: 'try', detail: 'try/except', template: 'try:\n\t${pass}\nexcept ${Exception} as ${error}:\n\t${raise}' },
  { label: 'with', detail: 'with open', template: 'with open(${"file.txt"}, encoding="utf-8") as ${f}:\n\t${data = f.read()}' },
];

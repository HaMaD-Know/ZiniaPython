"""zinia_draw / zinia_3d on desktop CPython (no preview: batches are recorded)."""

import glob
import json
import os

from ziniatest_support import RuntimeTestCase
from zinia import graphics, native

EXAMPLES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "examples", "graphics")


class GraphicsTestCase(RuntimeTestCase):
    def setUp(self):
        super().setUp()
        graphics.recorded.clear()
        self._limit = graphics.headless_frame_limit
        self.addCleanup(setattr, graphics, "headless_frame_limit", self._limit)
        self.assertFalse(native.AVAILABLE, "these tests expect desktop CPython without the native host")

    def batches(self, surface=None):
        return [b for b in graphics.recorded if surface is None or b["surface"] == surface]

    def commands(self, surface):
        return [c for b in self.batches(surface) for c in b["commands"]]


class DrawTests(GraphicsTestCase):
    def test_spec_example_produces_ordered_batch(self):
        code = (
            "import zinia_draw as gfx\n"
            "gfx.create_canvas(800, 600)\n"
            "gfx.set_background('#101525')\n"
            "gfx.circle(400, 300, 80, color='#00ffff')\n"
            "gfx.rectangle(100, 100, 200, 120, color='#ff00aa')\n"
            "gfx.line(50, 50, 750, 550, color='white', width=4)\n"
            "gfx.text(40, 40, 'Hello from ZiniaPython', color='white', size=28)\n"
            "gfx.polygon([(10, 10), (60, 10), (35, 50)], color='orange')\n"
            "gfx.show()\n"
        )
        r = self.run_code(code, execution_id="run-spec")
        self.assertEqual(r["status"], "ok", r["error"])
        batches = self.batches("2d")
        self.assertEqual(len(batches), 1)
        self.assertEqual(batches[0]["executionId"], "run-spec")
        ops = [c[0] for c in batches[0]["commands"]]
        self.assertEqual(ops, ["canvas", "bg", "circle", "rect", "line", "text", "poly"])
        self.assertEqual(batches[0]["commands"][2], ["circle", 400.0, 300.0, 80.0, "#00ffff", None, 1.0])
        # JSON-serialisable exactly as sent to the plugin
        json.dumps(batches[0], allow_nan=False)

    def test_unshown_drawing_is_sent_when_the_run_ends(self):
        r = self.run_code("import zinia_draw as gfx\ngfx.circle(10, 10, 5)\n")
        self.assertEqual(r["status"], "ok")
        self.assertEqual([c[0] for c in self.commands("2d")], ["canvas", "circle"])

    def test_outline_only_and_fill_with_outline(self):
        self.run_code("import zinia_draw as g\n"
                      "g.circle(1, 2, 3, color='red', fill=False, line_width=2)\n"
                      "g.rectangle(0, 0, 5, 5, color='blue', outline='white', line_width=3, corner_radius=2)\n")
        cmds = self.commands("2d")
        self.assertEqual(cmds[1], ["circle", 1.0, 2.0, 3.0, None, "red", 2.0])
        self.assertEqual(cmds[2], ["rect", 0.0, 0.0, 5.0, 5.0, "blue", "white", 3.0, 2.0])

    def test_colors(self):
        c = graphics.color
        self.assertEqual(c("#0ff"), "#0ff")
        self.assertEqual(c("rgb(1, 2, 3)"), "rgb(1, 2, 3)")
        self.assertEqual(c("hsl(200, 80%, 50%)"), "hsl(200, 80%, 50%)")
        self.assertEqual(c("Cyan"), "Cyan")
        self.assertEqual(c((300, -4, 10.4)), "rgb(255,0,10)")
        self.assertEqual(c((1, 2, 3, 0.5)), "rgba(1,2,3,0.5)")
        with self.assertRaises(ValueError):
            c("notacolour")
        with self.assertRaises(TypeError):
            c(12)

    def test_errors_point_at_the_users_line(self):
        cases = [
            ("g.circle(10, 10, -5)\n", "ValueError", "radius"),
            ("g.circle('a', 10, 5)\n", "TypeError", "x must be a number"),
            ("g.line(0, 0, 1, 1, color='nope')\n", "ValueError", "unknown color"),
            ("g.polygon([(0, 0), (1, 1)])\n", "ValueError", "at least 3 points"),
            ("g.create_canvas(5000, 10)\n", "ValueError", "at most"),
            ("g.text(0, 0, 'x', align='middle')\n", "ValueError", "align"),
            ("g.run_animation()\n", "RuntimeError", "set_update"),
        ]
        for line, err_type, fragment in cases:
            with self.subTest(line=line):
                r = self.run_code("import zinia_draw as g\nx = 1\n" + line)
                self.assertEqual(r["status"], "error")
                self.assertEqual(r["error"]["type"], err_type)
                self.assertIn(fragment, r["error"]["message"])
                self.assertEqual(r["error"]["location"]["lineno"], 3)
                self.assertTrue(r["error"]["location"]["filename"].endswith("main.py"))
                self.assertNotIn("zinia_draw.py", r["error"]["traceback"])

    def test_animation_calls_update_and_delivers_events(self):
        graphics.headless_frame_limit = 3
        code = (
            "import zinia_draw as g\n"
            "from zinia import graphics\n"
            "seen, frames = [], []\n"
            "g.on_pointer(lambda e: seen.append((e.type, e.x, e.y)))\n"
            "g.on_key(lambda e: seen.append((e.type, e.key)))\n"
            "graphics.inject_events([\n"
            "    {'type': 'down', 'x': 5, 'y': 6, 'id': 1, 'buttons': 1, 'surface': '2d'},\n"
            "    {'type': 'keydown', 'key': 'ArrowLeft', 'surface': '2d'},\n"
            "    {'type': 'down', 'x': 0.5, 'y': 0.5, 'id': 1, 'surface': '3d'},\n"
            "    {'type': 'ack', 'seq': 1, 'surface': '2d'},\n"
            "])\n"
            "def update(dt):\n"
            "    frames.append(dt)\n"
            "    g.clear()\n"
            "    g.circle(len(frames), 0, 1)\n"
            "g.set_update(update)\n"
            "g.run_animation(fps=30)\n"
            "print(len(frames), seen, g.pointer())\n"
        )
        r = self.run_code(code)
        self.assertEqual(r["status"], "ok", r["error"])
        self.assertEqual(r["stdout"], "3 [('down', 5.0, 6.0), ('down', 'ArrowLeft')] (5.0, 6.0, True)\n")
        frame_batches = [b for b in self.batches("2d") if any(c[0] == "circle" for c in b["commands"])]
        self.assertEqual(len(frame_batches), 3)
        seqs = [b["seq"] for b in self.batches("2d")]
        self.assertEqual(seqs, sorted(seqs))

    def test_stop_animation_from_update(self):
        graphics.headless_frame_limit = 100
        r = self.run_code("import zinia_draw as g\nn = []\n"
                          "def update(dt):\n    n.append(1)\n    if len(n) == 4:\n        g.stop_animation()\n"
                          "g.set_update(update)\ng.run_animation()\nprint(len(n))\n")
        self.assertEqual(r["stdout"], "4\n")

    def test_fps_is_validated(self):
        r = self.run_code("import zinia_draw as g\ng.set_update(lambda dt: None)\ng.run_animation(fps=500)\n")
        self.assertEqual(r["error"]["type"], "ValueError")

    def test_each_run_starts_fresh(self):
        self.run_code("import zinia_draw as g\ng.create_canvas(300, 200)\ng.on_pointer(print)\n"
                      "g.set_update(lambda dt: None)\n", execution_id="first")
        graphics.recorded.clear()
        r = self.run_code("import zinia_draw as g\nfrom zinia import graphics\n"
                          "print(g.size(), g._State.pointer_handler, g._animation.update)\ng.circle(1, 1, 1)\n",
                          execution_id="second")
        self.assertEqual(r["stdout"], "(800, 600) None None\n")
        self.assertEqual({b["executionId"] for b in graphics.recorded}, {"second"})
        self.assertEqual(self.commands("2d")[0], ["canvas", 800, 600])

    def test_error_after_drawing_still_sends_the_picture(self):
        r = self.run_code("import zinia_draw as g\ng.circle(1, 1, 1)\nraise ValueError('boom')\n")
        self.assertEqual(r["status"], "error")
        self.assertEqual([c[0] for c in self.commands("2d")], ["canvas", "circle"])


class SceneTests(GraphicsTestCase):
    def test_spec_example(self):
        code = (
            "import zinia_3d as scene\n"
            "scene.create_scene()\n"
            "scene.set_background('#101525')\n"
            "box = scene.add_box(x=0, y=0, z=0, width=2, height=2, depth=2, color='#00ffff')\n"
            "scene.add_sphere(x=3, y=0, z=0, radius=1, color='#ff00aa')\n"
            "scene.add_light('ambient', intensity=0.7)\n"
            "scene.add_light('directional', intensity=1.2)\n"
            "scene.set_camera(position=(6, 5, 8), target=(0, 0, 0))\n"
            "scene.show()\n"
            "print(len(scene.objects()), box)\n"
        )
        r = self.run_code(code)
        self.assertEqual(r["status"], "ok", r["error"])
        ops = [c["op"] for c in self.commands("3d")]
        self.assertEqual(ops, ["reset", "background", "add", "add", "light", "light", "camera"])
        add_box = self.commands("3d")[2]
        self.assertEqual(add_box["kind"], "box")
        self.assertEqual(add_box["params"], {"width": 2.0, "height": 2.0, "depth": 2.0})
        self.assertEqual(add_box["material"]["color"], "#00ffff")
        self.assertTrue(r["stdout"].startswith("4 "))

    def test_changes_are_coalesced_per_frame(self):
        r = self.run_code("import zinia_3d as s\nb = s.add_box()\ns.show()\n"
                          "b.rotate(0, 0.1, 0)\nb.rotate(0, 0.1, 0)\nb.position = (1, 2, 3)\nb.color = 'red'\n"
                          "s.show()\nprint(b.rotation, b.position)\n")
        self.assertEqual(r["status"], "ok", r["error"])
        last = self.batches("3d")[-1]["commands"]
        self.assertEqual(len(last), 1)
        self.assertEqual(last[0]["op"], "set")
        self.assertEqual(last[0]["rotation"], [0.0, 0.2, 0.0])
        self.assertEqual(last[0]["position"], [1.0, 2.0, 3.0])
        self.assertEqual(last[0]["color"], "red")

    def test_remove_and_use_after_remove(self):
        r = self.run_code("import zinia_3d as s\nb = s.add_sphere()\nb.remove()\nprint(len(s.objects()))\n"
                          "b.move(1, 0, 0)\n")
        self.assertEqual(r["stdout"], "0\n")
        self.assertEqual(r["status"], "error")
        self.assertEqual(r["error"]["location"]["lineno"], 5)
        self.assertIn("remove", [c["op"] for c in self.commands("3d")])

    def test_validation(self):
        cases = [
            "s.add_box(width=0)\n",
            "s.add_light('spot')\n",
            "s.set_camera(fov=170)\n",
            "s.add_sphere(segments=1)\n",
            "s.add_box(opacity=2)\n",
            "s.add_cylinder(radius_top=0, radius_bottom=0)\n",
        ]
        for line in cases:
            with self.subTest(line=line):
                r = self.run_code("import zinia_3d as s\n" + line)
                self.assertEqual(r["error"]["type"], "ValueError")
                self.assertEqual(r["error"]["location"]["lineno"], 2)

    def test_tap_events_resolve_objects(self):
        graphics.headless_frame_limit = 1
        r = self.run_code(
            "import zinia_3d as s\nfrom zinia import graphics\nb = s.add_box()\nhits = []\n"
            "s.on_tap(lambda e: hits.append((e.object is b, e.point)))\n"
            "graphics.inject_events([{'type': 'tap', 'object': b.id, 'point': [0, 0.5, 0], 'surface': '3d'},\n"
            "                        {'type': 'tap', 'object': None, 'point': None, 'surface': '3d'}])\n"
            "s.set_update(lambda dt: None)\ns.run_animation()\nprint(hits)\n")
        self.assertEqual(r["status"], "ok", r["error"])
        self.assertEqual(r["stdout"], "[(True, (0, 0.5, 0)), (False, None)]\n")


def touch(kind, x, y, finger=1, **extra):
    return {"type": kind, "x": x, "y": y, "id": finger, "surface": "2d", "pointerType": "touch", **extra}


def inject(events):
    """Source line that queues events as if the preview had posted them."""
    return f"from zinia import graphics as _zg\n_zg.inject_events({events!r})\n"


class TouchTests(GraphicsTestCase):
    def test_on_touch_exists_and_validates(self):
        r = self.run_code("import zinia_draw as gfx\nprint(callable(gfx.on_touch), 'on_touch' in gfx.__all__)\n"
                          "gfx.on_touch(42)\n")
        self.assertEqual(r["stdout"], "True True\n")
        self.assertEqual(r["error"]["type"], "TypeError")
        self.assertEqual(r["error"]["location"]["lineno"], 3)

    def test_event_format(self):
        events = [touch("down", 100, 200), touch("move", 110, 195), touch("move", 130, 190),
                  touch("up", 130, 190), touch("tap", 5, 6, finger=2),
                  touch("down", 1, 1, finger=3), touch("cancel", 2, 2, finger=3)]
        code = ("import zinia_draw as gfx\nseen = []\n"
                "gfx.on_touch(lambda e: seen.append((e.type, e.x, e.y, e.id, e.dx, e.dy, e.start_x, e.start_y,"
                " e.touches, e.cancelled, e.pointer_type)))\n" + inject(events) +
                "gfx.listen()\nfor s in seen:\n    print(s)\n")
        r = self.run_code(code)
        self.assertEqual(r["status"], "ok", r["error"])
        self.assertEqual(r["stdout"].splitlines(), [
            "('start', 100.0, 200.0, 1, 0.0, 0.0, 100.0, 200.0, 1, False, 'touch')",
            "('move', 110.0, 195.0, 1, 10.0, -5.0, 100.0, 200.0, 1, False, 'touch')",
            "('move', 130.0, 190.0, 1, 20.0, -5.0, 100.0, 200.0, 1, False, 'touch')",
            "('end', 130.0, 190.0, 1, 0.0, 0.0, 100.0, 200.0, 0, False, 'touch')",
            "('tap', 5.0, 6.0, 2, 0.0, 0.0, 5.0, 6.0, 0, False, 'touch')",
            "('start', 1.0, 1.0, 3, 0.0, 0.0, 1.0, 1.0, 1, False, 'touch')",
            "('end', 2.0, 2.0, 3, 1.0, 1.0, 1.0, 1.0, 0, True, 'touch')",
        ])

    def test_moves_without_a_touch_are_not_touch_events(self):
        # mouse hover, or a finger that went down before this run started
        events = [touch("move", 5, 5, pointerType="mouse"), touch("move", 6, 6, finger=9), touch("up", 6, 6, finger=9)]
        r = self.run_code("import zinia_draw as gfx\nt, p = [], []\ngfx.on_touch(lambda e: t.append(e.type))\n"
                          "gfx.on_pointer(lambda e: p.append(e.type))\n" + inject(events) + "gfx.listen()\nprint(t, p)\n")
        self.assertEqual(r["stdout"], "[] ['move', 'move', 'up']\n")

    def test_program_that_only_sets_on_touch_keeps_listening(self):
        # The user's pattern: draw, register on_touch, and the script ends.
        code = (
            "import zinia_draw as gfx\n"
            "gfx.create_canvas(800, 600)\n"
            "objects = [{'x': 200, 'y': 200, 'radius': 45}]\n"
            "def draw():\n"
            "    gfx.clear()\n"
            "    for obj in objects:\n"
            "        gfx.circle(obj['x'], obj['y'], obj['radius'], color='#00ffff')\n"
            "def on_touch(event):\n"
            "    if event.type == 'move':\n"
            "        objects[0]['x'], objects[0]['y'] = event.x, event.y\n"
            "        draw()\n"
            "draw()\n"
            "gfx.on_touch(on_touch)\n"
            + inject([touch("down", 200, 200), touch("move", 300, 250), touch("up", 300, 250)])
        )
        r = self.run_code(code)
        self.assertEqual(r["status"], "ok", r["error"])
        circles = [c for c in self.commands("2d") if c[0] == "circle"]
        self.assertEqual(circles[0][1:3], [200.0, 200.0])
        self.assertEqual(circles[-1][1:3], [300.0, 250.0])

    def test_no_extra_listening_after_run_animation(self):
        graphics.headless_frame_limit = 1
        r = self.run_code("import zinia_draw as gfx\nn = []\ngfx.on_touch(lambda e: n.append(e))\n"
                          "gfx.set_update(lambda dt: None)\ngfx.run_animation()\n"
                          + inject([touch("down", 1, 1)]) + "print('after')\n")
        self.assertEqual(r["status"], "ok", r["error"])
        self.assertEqual(r["stdout"], "after\n")  # the late event was not delivered by a second loop

    def test_stop_animation_ends_listen(self):
        events = [touch("down", 1, 1), touch("up", 1, 1), touch("down", 2, 2)]
        r = self.run_code("import zinia_draw as gfx\nseen = []\n"
                          "def on_touch(e):\n    seen.append(e.type)\n    if e.type == 'end':\n        gfx.stop_animation()\n"
                          "gfx.on_touch(on_touch)\n" + inject(events) + "gfx.listen()\nprint(seen)\n")
        self.assertEqual(r["stdout"], "['start', 'end']\n")

    def test_listen_needs_a_handler(self):
        r = self.run_code("import zinia_draw as gfx\ngfx.listen()\n")
        self.assertEqual(r["error"]["type"], "RuntimeError")

    def test_registering_again_replaces_the_handler(self):
        r = self.run_code("import zinia_draw as gfx\na, b = [], []\ngfx.on_touch(lambda e: a.append(1))\n"
                          "gfx.on_touch(lambda e: b.append(1))\n" + inject([touch("down", 1, 1)])
                          + "gfx.listen()\nprint(len(a), len(b))\n")
        self.assertEqual(r["stdout"], "0 1\n")

    def test_running_again_does_not_duplicate_events(self):
        code = ("import zinia_draw as gfx\ncount = []\ngfx.on_touch(lambda e: count.append(e.type))\n"
                + inject([touch("down", 1, 1), touch("up", 1, 1)]) + "gfx.listen()\nprint(count)\n")
        for _ in range(3):
            r = self.run_code(code)
            self.assertEqual(r["stdout"], "['start', 'end']\n")

    def test_handler_errors_point_at_the_handler(self):
        code = ("import zinia_draw as gfx\n"
                "def on_touch(e):\n"
                "    return 1 / 0\n"
                "gfx.on_touch(on_touch)\n" + inject([touch("down", 1, 1)]))
        r = self.run_code(code)
        self.assertEqual(r["status"], "error")
        self.assertEqual(r["error"]["type"], "ZeroDivisionError")
        self.assertEqual(r["error"]["location"]["lineno"], 3)

    def _drag_example(self, events):
        with open(os.path.join(EXAMPLES, "13_drag_circles.py"), encoding="utf-8") as fh:
            source = fh.read()
        source += "\n" + inject(events) + "_zg.keep_alive()\nprint([(o['color'], o['x'], o['y']) for o in objects])\n"
        r = self.run_code(source, filename="13_drag_circles.py")
        self.assertEqual(r["status"], "ok", r["error"] and r["error"]["traceback"])
        return dict((c, (x, y)) for c, x, y in eval(r["stdout"].splitlines()[-1]))  # noqa: S307 - our own output

    def test_drag_example_moves_only_the_touched_circle(self):
        pos = self._drag_example([touch("down", 210, 205), touch("move", 260, 255), touch("move", 300, 300),
                                  touch("up", 300, 300), touch("move", 700, 500)])
        self.assertEqual(pos["#00ffff"], (290.0, 295.0))   # keeps the grab offset
        self.assertEqual(pos["#ff5c8a"], (400, 320))
        self.assertEqual(pos["#ffd166"], (600, 220))

    def test_drag_example_ignores_empty_space_and_handles_two_fingers(self):
        pos = self._drag_example([touch("down", 50, 550), touch("move", 60, 560), touch("up", 60, 560),
                                  touch("down", 200, 200, finger=1), touch("down", 600, 220, finger=2),
                                  touch("move", 100, 100, finger=1), touch("move", 5000, 220, finger=2),
                                  touch("up", 100, 100, finger=1), touch("cancel", 5000, 220, finger=2)])
        self.assertEqual(pos["#00ffff"], (100.0, 100.0))
        self.assertEqual(pos["#ffd166"], (740.0, 220.0))   # clamped to the canvas
        self.assertEqual(pos["#ff5c8a"], (400, 320))


class ExampleTests(GraphicsTestCase):
    def test_every_bundled_example_runs(self):
        paths = sorted(glob.glob(os.path.join(EXAMPLES, "*.py")))
        self.assertEqual(len(paths), 13)
        for path in paths:
            with self.subTest(example=os.path.basename(path)):
                graphics.recorded.clear()
                with open(path, encoding="utf-8") as fh:
                    source = fh.read()
                r = self.run_code(source, filename=os.path.basename(path))
                self.assertEqual(r["status"], "ok", r["error"] and r["error"]["traceback"])
                self.assertTrue(graphics.recorded, "the example drew nothing")
                for batch in graphics.recorded:
                    json.dumps(batch, allow_nan=False)


class ReplTests(GraphicsTestCase):
    def test_repl_statements_show_their_drawing(self):
        from zinia import repl
        session = repl.ReplSession() if hasattr(repl, "ReplSession") else None
        if session is None:
            self.skipTest("REPL session class not found")
        session.execute(execution_id="r1", source="import zinia_draw as g", capture=True)
        session.execute(execution_id="r2", source="g.circle(5, 5, 2)", capture=True)
        sent = [b for b in graphics.recorded if b["executionId"] == "r2"]
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]["commands"][-1][0], "circle")

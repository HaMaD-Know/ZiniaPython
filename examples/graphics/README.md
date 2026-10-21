# Graphics examples

Open a file and press **Run**. The Graphics preview opens by itself when a
program draws. Programs that animate or wait for touches keep running until you press **Stop**.

| File | Module | What it shows |
| --- | --- | --- |
| `01_shapes_and_colors.py` | zinia_draw | Every 2D drawing function and colour format |
| `02_procedural_city.py` | zinia_draw | A generated skyline (change `SEED`) |
| `03_starfield.py` | zinia_draw | Animation; touch and hold to warp |
| `04_particles.py` | zinia_draw | Particles with gravity; tap for bursts |
| `05_drawing_canvas.py` | zinia_draw | Finger painting with a colour palette |
| `06_catch_game.py` | zinia_draw | A small game: drag or arrow keys |
| `07_rotating_cube.py` | zinia_3d | The classic rotating cube |
| `08_orbiting_objects.py` | zinia_3d | Several objects orbiting a light |
| `09_lit_scene.py` | zinia_3d | Materials and ambient, directional and point lights |
| `10_procedural_landscape.py` | zinia_3d | A block island built from a height map |
| `11_object_viewer.py` | zinia_3d | Tap objects to select them |
| `12_dodge_game.py` | zinia_3d | A small 3D game: steer with touches or arrow keys |
| `13_drag_circles.py` | zinia_draw | Drag three circles with your fingers (`on_touch`) |

These are copies: edit them freely. "Graphics examples" in the ⋯ menu adds
any example you deleted back, and never overwrites your changes.

The full API is described in `docs/GRAPHICS.md` in the ZiniaPython source,
and in each module's built-in help: `import zinia_draw; help(zinia_draw)`.

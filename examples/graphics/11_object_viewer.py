"""Interactive object viewer.

Tap an object to select it (it turns white and spins). Tap empty space to
deselect. Drag to orbit, pinch to zoom; 'Reset camera' in the panel returns
to the starting view. Keys (hardware keyboard): h hides the selected
object, s shows everything again.
"""
import zinia_3d as scene

scene.create_scene()
scene.set_background("#151a2e")
scene.add_plane(width=12, height=12, color="#232b48")
scene.add_light("ambient", intensity=0.45)
scene.add_light("directional", intensity=1.1, position=(5, 9, 4))

items = {
    "red box": scene.add_box(x=-3, y=0.75, z=0, width=1.5, height=1.5, depth=1.5, color="#ff5c8a"),
    "blue sphere": scene.add_sphere(x=0, y=1, z=0, radius=1, color="#4cc9f0"),
    "green cone": scene.add_cylinder(x=3, y=1, z=0, radius_top=0, radius_bottom=0.9, height=2, color="#06d6a0"),
    "gold pillar": scene.add_cylinder(x=0, y=1.25, z=-3, radius_top=0.4, radius_bottom=0.4, height=2.5,
                                      color="#ffd166", metalness=0.8, roughness=0.3),
}
original = {name: obj.color for name, obj in items.items()}
selected = {"name": None}

def name_of(obj):
    for name, candidate in items.items():
        if candidate is obj:
            return name
    return None

def select(name):
    if selected["name"]:
        items[selected["name"]].color = original[selected["name"]]
        items[selected["name"]].rotation = (0, 0, 0)
    selected["name"] = name
    if name:
        items[name].color = "white"
        print("Selected", name, "at", items[name].position)
    else:
        print("Nothing selected")

def on_tap(event):
    select(name_of(event.object) if event.object is not None else None)

def on_key(event):
    name = selected["name"]
    if event.type != "down":
        return
    if event.key == "h" and name:
        items[name].visible = False
    elif event.key == "s":
        for obj in items.values():
            obj.visible = True

def update(dt):
    if selected["name"]:
        items[selected["name"]].rotate(0, dt * 1.5, 0)

scene.set_camera(position=(0, 5, 9), target=(0, 1, 0))
scene.on_tap(on_tap)
scene.on_key(on_key)
scene.set_update(update)
print("Tap an object to select it.")
scene.run_animation()

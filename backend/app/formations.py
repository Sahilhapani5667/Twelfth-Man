"""Formation families, slot layouts for the lineup editor, and raw-code mapping."""

# StatsBomb formation codes -> the six families the platform exposes
FORMATION_FAMILY = {
    "4231": "4-2-3-1",
    "442": "4-4-2", "4411": "4-4-2", "41212": "4-4-2", "4222": "4-4-2", "424": "4-4-2",
    "433": "4-3-3", "4321": "4-3-3",
    "4141": "4-1-4-1", "451": "4-1-4-1",
    "352": "3-5-2", "3412": "3-5-2", "3511": "3-5-2", "3142": "3-5-2", "532": "3-5-2",
    "343": "3-4-3", "3421": "3-4-3", "541": "3-4-3",
}

FAMILIES = ["4-2-3-1", "4-3-3", "4-4-2", "4-1-4-1", "3-5-2", "3-4-3"]


def family_of(code) -> str:
    code = str(code or "")
    if code in FORMATION_FAMILY:
        return FORMATION_FAMILY[code]
    if code in FAMILIES:
        return code
    digits = code.replace("-", "")
    return FORMATION_FAMILY.get(digits, "4-4-2")


# Slot layouts: (role, x, y) on a 120 x 80 pitch, attacking towards x = 120.
LAYOUTS = {
    "4-2-3-1": [("GK", 6, 40), ("LB", 30, 70), ("LCB", 24, 52), ("RCB", 24, 28), ("RB", 30, 10),
                ("LDM", 46, 50), ("RDM", 46, 30), ("LAM", 72, 66), ("CAM", 70, 40), ("RAM", 72, 14),
                ("ST", 96, 40)],
    "4-3-3": [("GK", 6, 40), ("LB", 30, 70), ("LCB", 24, 52), ("RCB", 24, 28), ("RB", 30, 10),
              ("CDM", 44, 40), ("LCM", 58, 56), ("RCM", 58, 24), ("LW", 86, 68), ("ST", 96, 40),
              ("RW", 86, 12)],
    "4-4-2": [("GK", 6, 40), ("LB", 30, 70), ("LCB", 24, 52), ("RCB", 24, 28), ("RB", 30, 10),
              ("LM", 58, 70), ("LCM", 52, 48), ("RCM", 52, 32), ("RM", 58, 10), ("LS", 90, 50),
              ("RS", 90, 30)],
    "4-1-4-1": [("GK", 6, 40), ("LB", 30, 70), ("LCB", 24, 52), ("RCB", 24, 28), ("RB", 30, 10),
                ("CDM", 42, 40), ("LM", 66, 70), ("LCM", 62, 50), ("RCM", 62, 30), ("RM", 66, 10),
                ("ST", 94, 40)],
    "3-5-2": [("GK", 6, 40), ("LCB", 24, 60), ("CB", 22, 40), ("RCB", 24, 20), ("LWB", 54, 74),
              ("LCM", 54, 52), ("CDM", 46, 40), ("RCM", 54, 28), ("RWB", 54, 6), ("LS", 90, 50),
              ("RS", 90, 30)],
    "3-4-3": [("GK", 6, 40), ("LCB", 24, 60), ("CB", 22, 40), ("RCB", 24, 20), ("LWB", 56, 74),
              ("LCM", 50, 50), ("RCM", 50, 30), ("RWB", 56, 6), ("LW", 86, 64), ("ST", 96, 40),
              ("RW", 86, 16)],
}

NOTES = {
    "4-2-3-1": "Double pivot protects transitions; one creative 10 links midfield and striker.",
    "4-3-3": "Natural pressing shape; wingers pin full-backs and the 6 screens counters.",
    "4-4-2": "Two banks of four are compact and easy to coach; two strikers press centre-backs.",
    "4-1-4-1": "Very compact mid-block; the lone 6 shields the back four, wide players track back.",
    "3-5-2": "Extra centre-back against two strikers; wing-backs provide all the width.",
    "3-4-3": "Aggressive front three plus wing-backs; strong width, but space behind wing-backs.",
}

"""
Smoke tests for the digital twin segment.
Verifies that modules, models, and configurations load correctly without import errors.
"""

def test_twin_package_importable():
    import twin
    assert twin is not None


def test_numpy_available():
    import numpy as np
    # Basic sanity: RC model will use these operations
    arr = np.array([1.0, 2.0, 3.0])
    assert arr.mean() == 2.0
    assert len(arr) == 3

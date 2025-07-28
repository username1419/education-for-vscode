import unittest
from random import randint
import lesson2

class TestMyScript(unittest.TestCase):

    def test_main_output(self) -> None:
        test_cases = [
            ([1, 2, 3], 2),
            ([2, 4, 6], 16)
        ]

        for i in range(10): # TODO: fix floating point calculation errors
            w = randint(0, 2**12)
            d = randint(0, 2**12)
            h = randint(0, 2**12)
            test_cases.append(
                ([w, d, h], (1/3)*w*d*h)
            )

        for input, expected in test_cases:
            self.assertEqual(
                float(lesson2.calculate_pyramid_volume(input[0], input[1], input[2])).__round__(5),
                expected.__round__(5))


if __name__ == '__main__':
    unittest.main()
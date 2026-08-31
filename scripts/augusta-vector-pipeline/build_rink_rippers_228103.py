#!/usr/bin/env python3
"""Build an Illustrator-editable Rink Rippers design on Momentec style 228103.

The builder preserves Momentec's production size-L cut geometry and adds artwork
as named SVG groups. The attached front mockup is the visual source. Since it has
no back view and no original vector crest, the back is explicitly marked as an
inferred production concept and the crest remains a clean, editable reconstruction.
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path


BODY_GROUP = 'id:custom_design_line'


def _find_body_id(svg: str) -> str:
    group = re.search(
        rf'<g id="{re.escape(BODY_GROUP)}"[^>]*>(.*?)</g>\s*<g id="branding">',
        svg,
        flags=re.DOTALL,
    )
    if not group:
        raise ValueError(f'Could not find {BODY_GROUP!r} in production SVG')

    path = re.search(
        r'<path id="([^"]*SUB_FIRST_BODY_COLOR[^"]*)"',
        group.group(1),
    )
    if not path:
        raise ValueError('Could not find production body path')
    return path.group(1)


def _artwork(body_id: str) -> str:
    return f'''\
        <!-- JourneyAX editable reconstruction: Rink Rippers / Momentec 228103 -->
        <defs id="JAX_DEFINITIONS">
            <clipPath id="JAX_GARMENT_CLIP">
                <use xlink:href="#{body_id}"/>
            </clipPath>
            <pattern id="JAX_CRACK_PATTERN" width="92" height="92" patternUnits="userSpaceOnUse">
                <path d="M6 5 L30 24 L21 47 M30 24 L51 17 L68 39 L87 45 M21 47 L37 63 L29 87 M68 39 L58 62 L79 84"
                      fill="none" stroke="#C7B8E8" stroke-width="1.25" opacity="0.42"/>
                <path d="M4 73 L19 66 L34 75 M56 2 L62 15 L82 20"
                      fill="none" stroke="#100A16" stroke-width="1.8" opacity="0.55"/>
            </pattern>
            <pattern id="JAX_HALFTONE_PATTERN" width="24" height="24" patternUnits="userSpaceOnUse">
                <circle cx="4" cy="4" r="1.4" fill="#0B0910" opacity="0.32"/>
                <circle cx="16" cy="10" r="1" fill="#E8E8E8" opacity="0.24"/>
                <circle cx="9" cy="20" r="0.8" fill="#0B0910" opacity="0.28"/>
            </pattern>
            <style type="text/css"><![CDATA[
                .jax-display {{ font-family: 'Arial Black', Impact, sans-serif; font-weight: 900; }}
                .jax-athletic {{ font-family: Impact, 'Arial Narrow', sans-serif; font-weight: 900; }}
                .jax-outline {{ paint-order: stroke fill; stroke-linejoin: round; }}
            ]]></style>
        </defs>

        <g id="JAX_RINK_RIPPERS_ARTWORK" clip-path="url(#JAX_GARMENT_CLIP)">
            <g id="JAX_BASE_PURPLE">
                <rect x="0" y="0" width="1132.2" height="1460.56" fill="#32145F"/>
                <rect x="0" y="0" width="1132.2" height="1460.56" fill="url(#JAX_CRACK_PATTERN)"/>
                <rect x="0" y="0" width="1132.2" height="1460.56" fill="url(#JAX_HALFTONE_PATTERN)"/>
            </g>

            <g id="JAX_FRONT_BODY" data-source="front reference">
                <path id="JAX_FRONT_ORANGE_SHOULDER" fill="#FF6B1A"
                      d="M10 18 H555 V128 L534 120 515 132 493 119 470 135 448 121 427 131 405 116 382 130 358 119 335 132 312 116 288 128 265 112 240 130 216 116 190 131 165 115 140 130 115 114 88 127 62 112 34 126 10 115 Z"/>
                <path id="JAX_FRONT_BLACK_TEAR_TOP" fill="#0B0B10"
                      d="M5 119 L54 104 78 119 108 101 135 121 166 102 193 124 224 105 255 126 286 107 318 128 349 109 382 132 415 111 448 132 480 113 514 131 557 116 560 166 528 176 497 164 463 181 430 166 397 183 366 169 334 187 301 170 270 188 237 169 205 185 172 166 140 181 109 163 78 176 48 160 16 173 Z"/>
                <path id="JAX_FRONT_ICE_SLASH" fill="#E7EEF2"
                      d="M-15 322 L42 302 69 312 93 293 122 306 148 284 178 299 206 278 237 294 268 270 301 288 333 264 368 282 401 259 436 278 472 254 505 271 553 247 560 287 521 303 491 291 457 313 426 297 392 320 361 304 327 327 295 311 260 335 228 319 193 341 161 327 126 347 94 334 59 353 28 341 -12 357 Z"/>
                <path id="JAX_FRONT_LIME_TEAR" fill="#8EEA21"
                      d="M-20 346 L26 330 58 346 90 328 123 349 156 330 188 353 220 335 253 357 286 338 319 362 352 343 386 367 420 347 454 373 489 351 524 377 560 356 560 433 527 449 494 432 460 454 426 438 392 461 358 444 324 468 290 451 256 476 222 458 188 483 154 465 121 489 87 472 54 493 21 478 -20 498 Z"/>
                <path id="JAX_FRONT_BLACK_BREAK" fill="#0B0B10"
                      d="M-16 436 L20 422 49 435 80 416 110 433 142 412 173 430 205 408 237 427 270 404 303 424 336 401 370 422 404 399 438 419 472 397 507 417 560 391 560 429 522 446 489 432 455 453 421 438 387 460 353 445 319 467 286 451 252 474 218 458 184 480 150 464 116 486 82 470 48 490 14 475 -16 490 Z"/>
                <path id="JAX_FRONT_ORANGE_LOWER" fill="#FF6B1A"
                      d="M-12 466 L24 451 58 469 91 449 125 471 159 452 193 475 227 456 261 479 295 460 329 483 363 464 397 487 431 468 465 491 499 472 535 494 560 482 560 548 524 558 491 543 457 561 423 546 389 565 355 549 321 569 287 552 253 572 219 555 185 574 151 557 117 576 83 559 49 578 15 560 -12 571 Z"/>
                <path id="JAX_FRONT_WHITE_RIP_DETAIL" d="M34 207 L91 184 76 211 131 190 112 221 177 195 151 232 223 204 194 242 264 219 236 253 295 239 272 266 321 252 291 286 245 275 203 291 166 280 129 298 93 287 54 305 18 294 Z" fill="#E7EEF2" opacity="0.95"/>
            </g>

            <g id="JAX_BACK_BODY_INFERRED" data-source="inferred from front; no back reference supplied">
                <path fill="#FF6B1A" d="M584 25 H1124 V130 L1090 116 1058 132 1026 116 994 133 962 118 930 134 898 118 866 134 834 119 802 133 770 117 738 132 706 116 674 131 642 115 610 129 584 118 Z"/>
                <path fill="#0B0B10" d="M582 120 L620 103 652 121 684 104 716 123 748 105 780 125 812 107 844 127 876 109 908 129 940 111 972 130 1004 112 1036 132 1068 114 1126 136 1126 178 1090 163 1058 182 1026 166 994 184 962 168 930 186 898 170 866 188 834 172 802 190 770 174 738 192 706 176 674 194 642 178 610 196 582 182 Z"/>
                <path fill="#E7EEF2" d="M580 332 L620 313 653 329 686 309 720 331 754 311 788 334 822 314 856 337 890 317 924 340 958 320 992 343 1026 323 1060 346 1094 326 1128 344 1128 376 1093 359 1059 379 1025 361 991 382 957 364 923 385 889 367 855 388 821 370 787 391 753 373 719 394 685 376 651 397 617 379 580 400 Z"/>
                <path fill="#8EEA21" d="M580 365 L615 350 649 368 683 349 717 371 751 352 785 375 819 356 853 379 887 360 921 383 955 364 989 387 1023 368 1057 391 1091 372 1128 390 1128 456 1092 471 1058 454 1024 474 990 457 956 478 922 460 888 481 854 463 820 484 786 466 752 487 718 469 684 490 650 472 616 493 580 477 Z"/>
                <path fill="#0B0B10" d="M580 449 L616 432 650 449 684 430 718 452 752 433 786 456 820 437 854 460 888 441 922 464 956 445 990 468 1024 449 1058 472 1092 453 1128 470 1128 500 1092 486 1058 505 1024 489 990 509 956 492 922 513 888 495 854 516 820 498 786 519 752 501 718 522 684 504 650 525 616 507 580 523 Z"/>
                <path fill="#FF6B1A" d="M580 486 L616 470 650 487 684 468 718 490 752 471 786 494 820 475 854 498 888 479 922 502 956 483 990 506 1024 487 1058 510 1092 491 1128 508 1128 570 1092 580 1058 564 1024 582 990 566 956 584 922 568 888 586 854 570 820 588 786 572 752 590 718 574 684 592 650 576 616 594 580 578 Z"/>
            </g>

            <g id="JAX_LEFT_SLEEVE" data-source="front reference; UV panel separated">
                <path fill="#FF6B1A" d="M2 575 L555 575 L552 648 516 632 482 650 448 634 414 653 380 636 346 656 312 639 278 659 244 642 210 662 176 645 142 665 108 648 74 668 40 651 2 670 Z"/>
                <path fill="#0B0B10" d="M0 637 L38 618 72 637 106 617 140 640 174 620 208 643 242 623 276 646 310 626 344 649 378 629 412 652 446 632 480 655 514 635 558 654 558 727 522 744 488 727 454 748 420 730 386 751 352 733 318 754 284 736 250 757 216 739 182 760 148 742 114 763 80 745 46 766 0 747 Z"/>
                <path fill="#E7EEF2" d="M0 708 L42 689 76 707 110 687 144 710 178 690 212 713 246 693 280 716 314 696 348 719 382 699 416 722 450 702 484 725 518 705 558 723 558 751 522 769 488 752 454 773 420 755 386 776 352 758 318 779 284 761 250 782 216 764 182 785 148 767 114 788 80 770 46 791 0 772 Z"/>
                <path fill="#8EEA21" d="M0 742 L38 724 72 742 106 722 140 745 174 725 208 748 242 728 276 751 310 731 344 754 378 734 412 757 446 737 480 760 514 740 558 759 558 839 522 856 488 839 454 860 420 842 386 863 352 845 318 866 284 848 250 869 216 851 182 872 148 854 114 875 80 857 46 878 0 859 Z"/>
                <path fill="#0B0B10" d="M0 830 L42 812 76 830 110 810 144 833 178 813 212 836 246 816 280 839 314 819 348 842 382 822 416 845 450 825 484 848 518 828 558 846 558 884 522 902 488 885 454 906 420 888 386 909 352 891 318 912 284 894 250 915 216 897 182 918 148 900 114 921 80 903 46 924 0 905 Z"/>
                <path fill="#FF6B1A" d="M0 867 L38 850 72 868 106 848 140 871 174 851 208 874 242 854 276 877 310 857 344 880 378 860 412 883 446 863 480 886 514 866 558 884 558 962 522 980 488 963 454 984 420 966 386 987 352 969 318 990 284 972 250 993 216 975 182 996 148 978 114 999 80 981 46 1002 0 983 Z"/>
            </g>

            <g id="JAX_RIGHT_SLEEVE" data-source="front reference; mirrored UV orientation">
                <path fill="#FF6B1A" d="M466 587 L1068 587 L1068 657 1034 641 1000 660 966 643 932 663 898 646 864 666 830 649 796 669 762 652 728 672 694 655 660 675 626 658 592 678 558 661 524 681 490 664 466 676 Z"/>
                <path fill="#0B0B10" d="M460 649 L494 632 528 650 562 630 596 653 630 633 664 656 698 636 732 659 766 639 800 662 834 642 868 665 902 645 936 668 970 648 1004 671 1038 651 1072 668 1072 740 1038 758 1004 741 970 762 936 744 902 765 868 747 834 768 800 750 766 771 732 753 698 774 664 756 630 777 596 759 562 780 528 762 494 783 460 765 Z"/>
                <path fill="#E7EEF2" d="M460 721 L494 704 528 722 562 702 596 725 630 705 664 728 698 708 732 731 766 711 800 734 834 714 868 737 902 717 936 740 970 720 1004 743 1038 723 1072 740 1072 770 1038 788 1004 771 970 792 936 774 902 795 868 777 834 798 800 780 766 801 732 783 698 804 664 786 630 807 596 789 562 810 528 792 494 813 460 795 Z"/>
                <path fill="#8EEA21" d="M460 753 L494 736 528 754 562 734 596 757 630 737 664 760 698 740 732 763 766 743 800 766 834 746 868 769 902 749 936 772 970 752 1004 775 1038 755 1072 772 1072 852 1038 870 1004 853 970 874 936 856 902 877 868 859 834 880 800 862 766 883 732 865 698 886 664 868 630 889 596 871 562 892 528 874 494 895 460 877 Z"/>
                <path fill="#0B0B10" d="M460 840 L494 824 528 842 562 822 596 845 630 825 664 848 698 828 732 851 766 831 800 854 834 834 868 857 902 837 936 860 970 840 1004 863 1038 843 1072 860 1072 900 1038 918 1004 901 970 922 936 904 902 925 868 907 834 928 800 910 766 931 732 913 698 934 664 916 630 937 596 919 562 940 528 922 494 943 460 925 Z"/>
                <path fill="#FF6B1A" d="M460 879 L494 862 528 880 562 860 596 883 630 863 664 886 698 866 732 889 766 869 800 892 834 872 868 895 902 875 936 898 970 878 1004 901 1038 881 1072 898 1072 978 1038 996 1004 979 970 1000 936 982 902 1003 868 985 834 1006 800 988 766 1009 732 991 698 1012 664 994 630 1015 596 997 562 1018 528 1000 494 1021 460 1003 Z"/>
            </g>

            <g id="JAX_CUFF_YOKE_AND_COLLAR">
                <rect x="150" y="1068" width="470" height="256" fill="#111016"/>
                <rect x="390" y="1076" width="236" height="244" fill="#32145F"/>
                <path fill="#FF6B1A" d="M145 1080 H625 V1140 L590 1124 558 1142 526 1126 494 1144 462 1128 430 1146 398 1130 366 1148 334 1132 302 1150 270 1134 238 1152 206 1136 174 1154 145 1142 Z"/>
                <path fill="#09090D" d="M914 602 H1074 V772 H914 Z"/>
                <path fill="#FF6B1A" d="M920 612 H1068 V655 L1044 644 1020 658 996 645 972 660 948 646 920 662 Z"/>
                <path fill="#101016" d="M0 1290 H1132 V1461 H0 Z" opacity="0.92"/>
            </g>

            <g id="JAX_FRONT_CREST" data-source="editable reconstruction; replace with approved vector logo for production">
                <path fill="#0A0A0E" stroke="#E7EEF2" stroke-width="6" class="jax-outline"
                      d="M112 185 L151 165 174 178 204 153 230 171 264 146 291 168 323 149 349 172 382 155 404 180 446 166 431 204 461 225 431 244 452 274 417 288 437 319 398 327 409 365 370 362 363 403 328 385 304 423 281 389 244 410 232 371 194 379 199 340 159 333 177 298 140 283 167 254 129 231 159 211 Z"/>
                <path fill="#FF6B1A" d="M130 222 L186 198 170 225 234 198 216 231 283 202 263 237 334 207 312 244 385 214 360 252 431 226 402 266 344 280 294 270 244 284 198 272 151 287 121 266 Z"/>
                <text x="195" y="240" class="jax-display jax-outline" font-size="58" letter-spacing="1" fill="#8EEA21" stroke="#0B0B10" stroke-width="8">RINK</text>
                <text x="148" y="309" class="jax-display jax-outline" font-size="67" letter-spacing="-2" fill="#F3F5F6" stroke="#0B0B10" stroke-width="9">RIPPERS</text>
                <g id="JAX_PUCK_MONSTER">
                    <ellipse cx="290" cy="345" rx="62" ry="36" fill="#0A0A0E" stroke="#E7EEF2" stroke-width="7"/>
                    <path d="M244 342 Q290 378 337 342 Q326 392 290 397 Q254 392 244 342 Z" fill="#0A0A0E" stroke="#E7EEF2" stroke-width="6"/>
                    <path d="M255 351 L268 369 280 351 291 371 303 351 315 369 327 351" fill="#FFFFFF" stroke="#FFFFFF" stroke-width="3"/>
                    <path d="M271 383 Q290 394 310 383" fill="none" stroke="#FF4D2E" stroke-width="7"/>
                    <circle cx="264" cy="337" r="5" fill="#8EEA21"/><circle cx="316" cy="337" r="5" fill="#8EEA21"/>
                </g>
                <path id="JAX_HOCKEY_STICK" d="M365 183 L386 171 340 344 323 340 Z M323 340 Q311 365 282 374 L278 359 Q304 350 311 331 Z" fill="#E7EEF2" stroke="#0B0B10" stroke-width="6" stroke-linejoin="round"/>
            </g>

            <g id="JAX_ROSTER_PERSONALIZATION" data-source="editable placeholders">
                <text id="JAX_BACK_NAME" x="847" y="99" text-anchor="middle" class="jax-athletic jax-outline" font-size="48" letter-spacing="3" fill="#F3F5F6" stroke="#0B0B10" stroke-width="6">RINK RIPPERS</text>
                <text id="JAX_BACK_NUMBER" x="847" y="304" text-anchor="middle" class="jax-display jax-outline" font-size="224" fill="#F5E52A" stroke="#FF5A1F" stroke-width="11">23</text>
                <text id="JAX_LEFT_SLEEVE_NUMBER" x="300" y="800" text-anchor="middle" class="jax-display jax-outline" font-size="95" fill="#F5E52A" stroke="#FF5A1F" stroke-width="8">23</text>
                <text id="JAX_RIGHT_SLEEVE_NUMBER" transform="rotate(180 750 850)" x="750" y="884" text-anchor="middle" class="jax-display jax-outline" font-size="95" fill="#F5E52A" stroke="#FF5A1F" stroke-width="8">23</text>
            </g>
        </g>
'''


def build(source: Path, output: Path) -> None:
    svg = source.read_text(encoding='utf-8')
    body_id = _find_body_id(svg)

    svg = svg.replace(
        f'<g id="{BODY_GROUP}" display="none">',
        f'<g id="{BODY_GROUP}" display="inline">',
        1,
    )

    marker = '\t\t<g id="branding">'
    if marker not in svg:
        raise ValueError('Could not find artwork insertion point')
    svg = svg.replace(marker, _artwork(body_id) + marker, 1)

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(svg, encoding='utf-8')


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    build(args.source, args.output)
    print(args.output)


if __name__ == '__main__':
    main()
